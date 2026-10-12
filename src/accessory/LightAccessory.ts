import { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { Platform } from '../platform';
import { ResolvedLight } from '../config';
import { DeviceLog, TuyaDevice } from '../tuya/device';
import { Dps } from '../tuya/protocol';
import { LightPatch, LightProfile, LightState, buildDps, buildProfile, miredBounds, readState } from '../tuya/light';

/** HomeKit sends On, Brightness, Hue and Saturation as separate writes: wait a moment and send one command. */
const BATCH_MS = 60;
/** How long to wait before looking for a light that was not found on the network. */
const LOCATE_RETRY_MS = 60_000;

interface Batch {
    patch: LightPatch;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class LightAccessory {
    private readonly service: Service;
    private readonly log: DeviceLog;
    private device?: TuyaDevice;
    private profile: LightProfile | null = null;
    private state: LightState = { on: false, brightness: 100, mode: 'white' };
    private readonly bound = new Set<string>();
    private batch?: Batch;
    private locateTimer?: NodeJS.Timeout;
    private stopped = false;

    constructor(
        private readonly platform: Platform,
        private readonly accessory: PlatformAccessory,
        private readonly light: ResolvedLight,
    ) {
        const { Service, Characteristic } = platform.api.hap;
        const prefix = `[${light.name}]`;
        this.log = {
            debug: (m, ...a) => platform.log.debug(`${prefix} ${m}`, ...a),
            info: (m, ...a) => platform.log.info(`${prefix} ${m}`, ...a),
            warn: (m, ...a) => platform.log.warn(`${prefix} ${m}`, ...a),
            error: (m, ...a) => platform.log.error(`${prefix} ${m}`, ...a),
        };

        accessory.getService(Service.AccessoryInformation)!
            .setCharacteristic(Characteristic.Manufacturer, 'Tuya (Smart Life)')
            .setCharacteristic(Characteristic.Model, light.productName || light.category || 'Light')
            .setCharacteristic(Characteristic.SerialNumber, light.id);

        this.service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb, light.name);
        this.service.setCharacteristic(Characteristic.Name, light.name);

        this.bind(Characteristic.On, 'on', (v) => this.enqueue({ on: Boolean(v) }), () => this.state.on);

        // With cloud information the capabilities are known right away; otherwise they are read from the light.
        const profile = buildProfile(light.dps, {}, { min: light.minKelvin, max: light.maxKelvin });
        if (profile) {
            this.applyProfile(profile);
        }
    }

    /** Starts talking to the light, after having found it on the network if needed. */
    async start() {
        this.stopped = false;
        let ip = this.light.ip;
        if (!ip) {
            ip = await this.find();
        }
        if (!ip || this.stopped) {
            return;
        }
        this.connect(ip);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.locateTimer);
        if (this.batch) {
            clearTimeout(this.batch.timer);
            this.batch.reject(new Error('stopped'));
            this.batch = undefined;
        }
        this.device?.stop();
    }

    // ---------------------------------------------------------------------------------------
    // Network
    // ---------------------------------------------------------------------------------------

    private async find(): Promise<string | undefined> {
        this.log.debug('looking for the light on the network');
        const found = await this.platform.locator.locate(this.light.id);
        if (this.stopped) {
            return undefined;
        }
        if (!found) {
            this.log.warn(
                'Not found on the network. Is it plugged in and on the same Wi-Fi as Homebridge? '
                + `Trying again in ${LOCATE_RETRY_MS / 1000} s. `
                + 'You can also set its "ip" in the plugin configuration.');
            this.locateTimer = setTimeout(() => void this.start(), LOCATE_RETRY_MS);
            return undefined;
        }
        this.platform.remember(this.light.id, { ip: found.ip, version: found.version ?? this.light.version });
        if (found.version && !this.light.version) {
            this.light.version = found.version;
        }
        return found.ip;
    }

    private connect(ip: string) {
        const device = new TuyaDevice({
            id: this.light.id,
            key: this.light.key,
            ip,
            port: this.light.port,
            version: this.light.version,
            lockVersion: this.light.lockVersion,
            log: this.log,
        });
        this.device = device;

        device.on('connected', (version) => {
            this.log.info(`Connected (protocol ${version})`);
            this.platform.remember(this.light.id, { ip: device.address, version });
        });
        device.on('disconnected', () => this.log.warn('Connection lost, reconnecting…'));
        device.on('dps', (_changed, all) => this.onDps(all));
        device.on('connect-failed', (error, count) => {
            if (count === 1 || count % 10 === 0) {
                this.log.warn(`Cannot reach the light (${error.message})${count === 1 ? ', will keep trying' : ''}`);
            }
            if (count % 3 === 0) {
                void this.relocate(device);
            }
        });
        device.start();
    }

    /** The light may have a new IP address (DHCP lease renewed). */
    private async relocate(device: TuyaDevice) {
        const found = await this.platform.locator.locate(this.light.id);
        if (found && found.ip !== device.address && !this.stopped) {
            this.log.info(`The light is now at ${found.ip}`);
            this.platform.remember(this.light.id, { ip: found.ip });
            device.setAddress(found.ip);
        }
    }

    // ---------------------------------------------------------------------------------------
    // HomeKit
    // ---------------------------------------------------------------------------------------

    private bind(
        characteristic: typeof Characteristic.On | typeof Characteristic.Brightness | typeof Characteristic.ColorTemperature
            | typeof Characteristic.Hue | typeof Characteristic.Saturation,
        name: string,
        set: (value: CharacteristicValue) => Promise<void>,
        get: () => CharacteristicValue | undefined,
    ) {
        if (this.bound.has(name)) {
            return;
        }
        this.bound.add(name);
        this.service.getCharacteristic(characteristic)
            .onGet(() => {
                const value = get();
                if (!this.device?.isReady || value === undefined) {
                    throw this.commError();
                }
                return value;
            })
            .onSet(set);
    }

    private commError() {
        const { HapStatusError, HAPStatus } = this.platform.api.hap;
        return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    private applyProfile(profile: LightProfile) {
        const { Characteristic } = this.platform.api.hap;
        this.profile = profile;

        if (profile.brightness || profile.color) {
            this.setRange(this.service.getCharacteristic(Characteristic.Brightness), 1, 100, this.state.brightness);
            this.bind(Characteristic.Brightness, 'brightness', (v) => this.enqueue({ brightness: Number(v) }), () => this.state.brightness);
        }
        if (profile.colorTemp) {
            const { min, max } = miredBounds(profile);
            this.setRange(this.service.getCharacteristic(Characteristic.ColorTemperature), min, max, this.state.colorTemperature ?? max);
            this.bind(Characteristic.ColorTemperature, 'colorTemperature', (v) => this.enqueue({ colorTemperature: Number(v) }),
                () => this.state.colorTemperature ?? max);
        }
        if (profile.color) {
            this.bind(Characteristic.Hue, 'hue', (v) => this.enqueue({ hue: Number(v) }), () => this.state.hue ?? 0);
            this.bind(Characteristic.Saturation, 'saturation', (v) => this.enqueue({ saturation: Number(v) }),
                () => this.state.saturation ?? 0);
        }
    }

    /**
     * Narrows the range of a characteristic. HAP checks the value it holds against the new range, and a fresh
     * characteristic holds a default (0, 140 mireds) that may be outside it: put a valid value in first.
     * The value must also be valid for the current range, hence the clamp to the HAP defaults.
     */
    private setRange(characteristic: Characteristic, min: number, max: number, initial: number) {
        const { minValue = 0, maxValue = 100 } = characteristic.props;
        const inBoth = Math.min(Math.max(initial, min, minValue), max, maxValue);
        characteristic.updateValue(inBoth);
        characteristic.setProps({ minValue: min, maxValue: max });
    }

    private onDps(all: Dps) {
        if (!this.profile) {
            const profile = buildProfile(this.light.dps, all, { min: this.light.minKelvin, max: this.light.maxKelvin });
            if (!profile) {
                this.log.warn(`This device does not look like a light (data points: ${Object.keys(all).join(', ')}).`);
                return;
            }
            this.applyProfile(profile);
        }
        this.state = readState(this.profile!, all, this.state);
        this.publish();
    }

    private publish() {
        const { Characteristic } = this.platform.api.hap;
        const p = this.profile;
        const s = this.state;
        this.service.updateCharacteristic(Characteristic.On, s.on);
        if (p?.brightness || p?.color) {
            this.service.updateCharacteristic(Characteristic.Brightness, s.brightness);
        }
        if (p?.colorTemp && s.colorTemperature !== undefined) {
            this.service.updateCharacteristic(Characteristic.ColorTemperature, s.colorTemperature);
        }
        if (p?.color && s.hue !== undefined && s.saturation !== undefined) {
            this.service.updateCharacteristic(Characteristic.Hue, s.hue);
            this.service.updateCharacteristic(Characteristic.Saturation, s.saturation);
        }
    }

    private enqueue(patch: LightPatch): Promise<void> {
        if (!this.batch) {
            let resolve!: () => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.batch = { patch: {}, promise, resolve, reject, timer: setTimeout(() => void this.flush(), BATCH_MS) };
        }
        Object.assign(this.batch.patch, patch);
        return this.batch.promise;
    }

    private async flush() {
        const batch = this.batch;
        this.batch = undefined;
        if (!batch) {
            return;
        }
        try {
            if (!this.profile || !this.device?.isReady) {
                throw new Error('the light is not connected');
            }
            const dps = buildDps(this.profile, batch.patch, this.state);
            if (Object.keys(dps).length > 0) {
                this.log.debug(`-> ${JSON.stringify(dps)}`);
                await this.device.set(dps);
            }
            batch.resolve();
        } catch (e) {
            this.log.error(`Could not change the light: ${(e as Error).message}`);
            batch.reject(this.commError());
            // HomeKit now shows what the light really is
            if (this.device?.isReady) {
                this.publish();
            }
        }
    }
}
