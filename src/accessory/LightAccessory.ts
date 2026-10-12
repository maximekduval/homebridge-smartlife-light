import { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { Platform } from '../platform';
import { ResolvedLight } from '../config';
import { DeviceLog, TuyaDevice } from '../tuya/device';
import { ExtraSpec } from '../extras';
import { Dps } from '../tuya/protocol';
import {
    LightPatch, LightProfile, LightState, brightnessToHomeKit, brightnessToTuya, buildDps, buildProfile, miredBounds, readState,
} from '../tuya/light';

/** HomeKit sends On, Brightness, Hue and Saturation as separate writes: wait a moment and send one command. */
const BATCH_MS = 60;
/** How long to wait before looking for a light that was not found on the network. */
const LOCATE_RETRY_MS = 60_000;

interface Batch {
    patch: LightPatch;
    /** Data points to send as they are (extras), on top of what the light patch produces. */
    raw: Dps;
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
    private lastDps: Dps = {};
    /** One per extra: copies the light's data points into the HomeKit characteristics. */
    private readonly refreshers: Array<(dps: Dps) => void> = [];
    /** Last non-zero speed of each fan, to resume at it when switched on again. */
    private readonly lastSpeed = new Map<number, number>();

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

        // the main light is the one without a subtype: the extras can be lights too
        this.service = accessory.services.find((s) => s.UUID === Service.Lightbulb.UUID && !s.subtype)
            ?? accessory.addService(Service.Lightbulb, light.name);
        this.service.setCharacteristic(Characteristic.Name, light.name);
        this.service.setPrimaryService(true);

        this.bind(Characteristic.On, 'on', (v) => this.enqueue({ on: Boolean(v) }), () => this.state.on);

        // With cloud information the capabilities are known right away; otherwise they are read from the light.
        const profile = this.detectProfile({});
        if (profile) {
            this.applyProfile(profile);
        }

        this.setupExtras(light.extras);
    }

    private detectProfile(live: Dps): LightProfile | null {
        return buildProfile(this.light.dps, live, { min: this.light.minKelvin, max: this.light.maxKelvin },
            { whiteBrightness: this.light.whiteBrightness });
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
        this.lastDps = all;
        if (!this.profile) {
            const profile = this.detectProfile(all);
            if (profile) {
                this.applyProfile(profile);
            } else if (this.light.extras.length === 0) {
                this.log.warn(`This device does not look like a light (data points: ${Object.keys(all).join(', ')}).`);
                return;
            }
        }
        if (this.profile) {
            this.state = readState(this.profile, all, this.state);
        }
        this.publish();
    }

    private publish() {
        const { Characteristic } = this.platform.api.hap;
        const p = this.profile;
        const s = this.state;
        for (const refresh of this.refreshers) {
            refresh(this.lastDps);
        }
        if (!p) {
            return;
        }
        this.service.updateCharacteristic(Characteristic.On, s.on);
        if (p.brightness || p.color) {
            this.service.updateCharacteristic(Characteristic.Brightness, s.brightness);
        }
        if (p.colorTemp && s.colorTemperature !== undefined) {
            this.service.updateCharacteristic(Characteristic.ColorTemperature, s.colorTemperature);
        }
        if (p.color && s.hue !== undefined && s.saturation !== undefined) {
            this.service.updateCharacteristic(Characteristic.Hue, s.hue);
            this.service.updateCharacteristic(Characteristic.Saturation, s.saturation);
        }
    }

    /**
     * Queues a change. `raw` are data points sent as they are; `defaults` only fill in data points nobody else
     * asked for in the same batch (HomeKit may send "fan on" and "fan speed 40%" together: the speed must win).
     */
    private enqueue(patch: LightPatch, raw: Dps = {}, defaults: Dps = {}): Promise<void> {
        if (!this.batch) {
            let resolve!: () => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.batch = { patch: {}, raw: {}, promise, resolve, reject, timer: setTimeout(() => void this.flush(), BATCH_MS) };
        }
        Object.assign(this.batch.patch, patch);
        Object.assign(this.batch.raw, raw);
        for (const [dp, value] of Object.entries(defaults)) {
            if (!(dp in this.batch.raw)) {
                this.batch.raw[dp] = value;
            }
        }
        return this.batch.promise;
    }

    private async flush() {
        const batch = this.batch;
        this.batch = undefined;
        if (!batch) {
            return;
        }
        try {
            if (!this.device?.isReady) {
                throw new Error('the light is not connected');
            }
            const dps: Dps = {};
            if (Object.keys(batch.patch).length > 0) {
                if (!this.profile) {
                    throw new Error('the light has not reported its capabilities yet');
                }
                Object.assign(dps, buildDps(this.profile, batch.patch, this.state));
            }
            Object.assign(dps, batch.raw);
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

    // ---------------------------------------------------------------------------------------
    // Extra controls
    // ---------------------------------------------------------------------------------------

    private setupExtras(specs: ExtraSpec[]) {
        const { Service } = this.platform.api.hap;
        const wanted = new Set<string>();

        for (const spec of specs) {
            const subtype = `extra-${spec.dp}`;
            wanted.add(subtype);
            switch (spec.type) {
                case 'switch': this.addSwitch(this.extraService(Service.Switch, spec, subtype), spec); break;
                case 'light': this.addLight(this.extraService(Service.Lightbulb, spec, subtype), spec); break;
                case 'fan': this.addFan(this.extraService(Service.Fanv2, spec, subtype), spec); break;
                case 'all': this.addAll(this.extraService(Service.Switch, spec, subtype), spec); break;
            }
        }

        // tiles of extras that were removed from the configuration
        for (const service of [...this.accessory.services]) {
            if (service.subtype?.startsWith('extra-') && !wanted.has(service.subtype)) {
                this.accessory.removeService(service);
            }
        }
    }

    /** Finds the service of an extra in the cached accessory, or creates it. */
    private extraService(
        type: typeof Service.Switch | typeof Service.Lightbulb | typeof Service.Fanv2, spec: ExtraSpec, subtype: string,
    ): Service {
        const { Characteristic } = this.platform.api.hap;
        // the type of an extra may have changed in the configuration: drop what was there under another type
        for (const old of [...this.accessory.services]) {
            if (old.subtype === subtype && old.UUID !== type.UUID) {
                this.accessory.removeService(old);
            }
        }
        let service = this.accessory.getServiceById(type, subtype);
        if (!service) {
            service = this.accessory.addService(type, spec.name, subtype);
            // the Home app lets the user rename a tile: only ever set the configured name on creation
            service.addOptionalCharacteristic(Characteristic.ConfiguredName);
            service.setCharacteristic(Characteristic.ConfiguredName, spec.name);
        }
        service.setCharacteristic(Characteristic.Name, spec.name);
        return service;
    }

    /**
     * Whether an extra that needs the lamp to be powered can be doing anything. A lamp that is off is not rotating
     * whatever speed it remembers, so the Home app must not show that speed; the data point itself is left alone, so
     * that the rotation resumes where it was.
     */
    private powered(spec: ExtraSpec, dps: Dps): boolean {
        return !spec.powerOn || !this.profile || Boolean(dps[this.profile.on]);
    }

    private readDp<T>(dp: number, convert: (raw: unknown) => T): T {
        if (!this.device?.isReady) {
            throw this.commError();
        }
        return convert(this.device.dps[dp]);
    }

    /** Same as `readDp`, for an extra: the conversion also learns whether the lamp is powered. */
    private readExtraState<T>(spec: ExtraSpec, convert: (raw: unknown, powered: boolean) => T): T {
        if (!this.device?.isReady) {
            throw this.commError();
        }
        const dps = this.device.dps;
        return convert(dps[spec.dp], this.powered(spec, dps));
    }

    /** Sends a change of an extra. Turning one on also powers the lamp when the light needs it. */
    private writeExtra(spec: ExtraSpec, raw: Dps, turningOn = false, defaults: Dps = {}): Promise<void> {
        const power: Dps = {};
        if (spec.powerOn && turningOn && this.profile && !this.state.on) {
            power[this.profile.on] = true;
        }
        return this.enqueue({}, { ...raw, ...power }, defaults);
    }

    private addSwitch(service: Service, spec: ExtraSpec) {
        const { Characteristic } = this.platform.api.hap;
        service.getCharacteristic(Characteristic.On)
            .onGet(() => this.readExtraState(spec, (raw, powered) => powered && Boolean(raw)))
            .onSet((v) => this.writeExtra(spec, { [spec.dp]: Boolean(v) }, Boolean(v)));
        this.refreshers.push((dps) => service.updateCharacteristic(Characteristic.On, this.powered(spec, dps) && Boolean(dps[spec.dp])));
    }

    private addLight(service: Service, spec: ExtraSpec) {
        const { Characteristic } = this.platform.api.hap;
        this.addSwitch(service, spec);

        this.dropColour(service);

        const brightnessDp = spec.brightnessDp;
        if (brightnessDp === undefined) {
            return;
        }
        const toPercent = (raw: unknown) => brightnessToHomeKit(Number(raw), spec.min, spec.max);
        this.setRange(service.getCharacteristic(Characteristic.Brightness), 1, 100, 100);
        service.getCharacteristic(Characteristic.Brightness)
            .onGet(() => this.readDp(brightnessDp, toPercent))
            .onSet((v) => this.writeExtra(spec, { [brightnessDp]: brightnessToTuya(Number(v), spec.min, spec.max) }));
        this.refreshers.push((dps) => {
            if (typeof dps[brightnessDp] === 'number') {
                service.updateCharacteristic(Characteristic.Brightness, toPercent(dps[brightnessDp]));
            }
        });
    }

    /**
     * Master switch. It shows "on" only when the lamp is powered and every other extra is on, so that one tap from
     * any partial state switches everything on; and one tap from "all on" switches the lamp (and so everything) off.
     */
    private addAll(service: Service, spec: ExtraSpec) {
        const { Characteristic } = this.platform.api.hap;
        const members = () => this.light.extras.filter((e) => e !== spec && e.type !== 'all');
        const isOn = (e: ExtraSpec, dps: Dps) => (e.type === 'fan' ? Number(dps[e.dp]) > e.min : Boolean(dps[e.dp]));
        const allOn = (dps: Dps) => Boolean(dps[spec.dp]) && members().every((e) => isOn(e, dps));

        service.getCharacteristic(Characteristic.On)
            .onGet(() => {
                if (!this.device?.isReady) {
                    throw this.commError();
                }
                return allOn(this.device.dps);
            })
            .onSet((value) => {
                if (!value) {
                    return this.enqueue({}, { [spec.dp]: false });
                }
                const dps = this.device?.dps ?? {};
                const raw: Dps = { [spec.dp]: true };
                const defaults: Dps = {};
                for (const member of members()) {
                    if (isOn(member, dps)) {
                        continue;
                    }
                    if (member.type === 'fan') {
                        defaults[member.dp] = this.lastSpeed.get(member.dp) ?? member.max; // resume where it was
                    } else {
                        raw[member.dp] = true;
                    }
                }
                return this.enqueue({}, raw, defaults);
            });
        this.refreshers.push((dps) => service.updateCharacteristic(Characteristic.On, allOn(dps)));
    }

    /**
     * An extra light has no colour: the Home app shows a colour picker as soon as a light has a hue, and there is
     * nothing for it to do. Version 0.3.0 added a fixed hue and saturation to the stars, and Homebridge keeps them in
     * its cache, so they are removed here.
     */
    private dropColour(service: Service) {
        const { Characteristic } = this.platform.api.hap;
        for (const characteristic of [Characteristic.Hue, Characteristic.Saturation]) {
            if (service.testCharacteristic(characteristic)) {
                service.removeCharacteristic(service.getCharacteristic(characteristic));
            }
        }
    }

    private addFan(service: Service, spec: ExtraSpec) {
        const { Characteristic } = this.platform.api.hap;
        const span = spec.max - spec.min;
        const toPercent = (raw: unknown) => Math.min(100, Math.max(0, Math.round(((Number(raw) - spec.min) / span) * 100)));
        const toRaw = (percent: number) => Math.round(spec.min + (Math.min(100, Math.max(0, percent)) / 100) * span);
        const running = (raw: unknown) => Number(raw) > spec.min;

        service.getCharacteristic(Characteristic.Active)
            .onGet(() => this.readExtraState(spec, (raw, powered) => (powered && running(raw) ? 1 : 0)))
            .onSet((v) => {
                const on = Number(v) === 1;
                // switching on resumes the previous speed, unless a speed is set in the same batch
                const resume = { [spec.dp]: this.lastSpeed.get(spec.dp) ?? spec.max };
                return this.writeExtra(spec, on ? {} : { [spec.dp]: spec.min }, on, on ? resume : {});
            });
        service.getCharacteristic(Characteristic.RotationSpeed)
            .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
            .onGet(() => this.readExtraState(spec, (raw, powered) => (powered ? toPercent(raw) : 0)))
            .onSet((v) => {
                const raw = toRaw(Number(v));
                return this.writeExtra(spec, { [spec.dp]: raw }, raw > spec.min);
            });

        this.refreshers.push((dps) => {
            const raw = Number(dps[spec.dp]);
            if (Number.isNaN(raw)) {
                return;
            }
            if (raw > spec.min) {
                this.lastSpeed.set(spec.dp, raw);
            }
            const powered = this.powered(spec, dps);
            service.updateCharacteristic(Characteristic.Active, powered && running(raw) ? 1 : 0);
            service.updateCharacteristic(Characteristic.RotationSpeed, powered ? toPercent(raw) : 0);
        });
    }
}
