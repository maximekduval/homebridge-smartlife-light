import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LightAccessory } from './accessory/LightAccessory';
import { DeviceOverride, resolveLights } from './config';
import { Locator } from './locator';
import { DeviceStore, StoredDevice } from './store';

/**
 * Registers one HomeKit light per Tuya light found in the setup file (and in the plugin configuration).
 */
export class Platform implements DynamicPlatformPlugin {
    readonly store: DeviceStore;
    readonly locator: Locator;

    private readonly cached = new Map<string, PlatformAccessory>();
    private readonly lights = new Map<string, LightAccessory>();

    constructor(public readonly log: Logger, public readonly config: PlatformConfig, public readonly api: API) {
        this.store = new DeviceStore(api.user.storagePath());
        this.locator = new Locator(8000, (message) => log.debug(message));

        api.on('didFinishLaunching', () => this.start());
        api.on('shutdown', () => {
            for (const light of this.lights.values()) {
                light.stop();
            }
        });
    }

    /** Called by Homebridge for each accessory it restored from its cache. */
    configureAccessory(accessory: PlatformAccessory) {
        this.cached.set(accessory.UUID, accessory);
    }

    /** Remembers what was learned about a light (IP address, protocol version) so the next start is faster. */
    remember(id: string, changes: Partial<StoredDevice>) {
        try {
            this.store.patch(id, changes);
        } catch (e) {
            this.log.debug(`Could not save ${id}: ${(e as Error).message}`);
        }
    }

    private start() {
        let stored: StoredDevice[] = [];
        try {
            stored = this.store.read().devices;
        } catch (e) {
            this.log.error((e as Error).message);
        }

        const overrides: DeviceOverride[] = Array.isArray(this.config.devices) ? this.config.devices : [];
        const { lights, skipped, problems } = resolveLights(stored, overrides);
        for (const problem of problems) {
            this.log.warn(problem);
        }
        for (const entry of skipped) {
            this.log.debug(`Ignoring ${entry}`);
        }
        if (lights.length === 0) {
            this.log.warn('No light to expose yet. Run "smartlife-light setup" in a terminal to link your Smart Life account '
                + '(see the README), then restart Homebridge.');
        }

        const wanted = new Set<string>();
        for (const light of lights) {
            const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${light.id}`);
            wanted.add(uuid);

            let accessory = this.cached.get(uuid);
            if (!accessory) {
                this.log.info(`Adding ${light.name}`);
                accessory = new this.api.platformAccessory(light.name, uuid);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            accessory.context.deviceId = light.id;

            const handler = new LightAccessory(this, accessory, light);
            this.lights.set(light.id, handler);
            void handler.start();
        }

        const stale = [...this.cached].filter(([uuid]) => !wanted.has(uuid)).map(([, accessory]) => accessory);
        if (stale.length > 0) {
            this.log.info(`Removing ${stale.map((a) => a.displayName).join(', ')}`);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        }
    }
}
