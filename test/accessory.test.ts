import { afterEach, describe, expect, it } from 'vitest';
import * as hap from 'hap-nodejs';
import { LightAccessory } from '../src/accessory/LightAccessory';
import { ResolvedLight } from '../src/config';
import { DpInfo } from '../src/tuya/light';
import { ProtocolVersion } from '../src/tuya/protocol';
import { FakeTuyaDevice } from './helpers/fakeDevice';

const ID = 'bf0123456789abcdef0123';
const KEY = '0123456789abcdef';
const { Characteristic, Service } = hap;

const CLOUD: DpInfo[] = [
    { id: 20, code: 'switch_led' }, { id: 21, code: 'work_mode' },
    { id: 22, code: 'bright_value_v2', min: 10, max: 1000 }, { id: 23, code: 'temp_value_v2', min: 0, max: 1000 }, { id: 24, code: 'colour_data_v2' },
];

const accessories: LightAccessory[] = [];
const fakes: FakeTuyaDevice[] = [];

afterEach(async () => {
    for (const a of accessories.splice(0)) {
        a.stop();
    }
    for (const f of fakes.splice(0)) {
        await f.close();
    }
});

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function setup(version: ProtocolVersion, withCloudInfo = true) {
    const fake = new FakeTuyaDevice(ID, KEY, version, { 20: false, 21: 'white', 22: 505, 23: 500, 24: '000003e803e8' });
    await fake.listen();
    fakes.push(fake);

    const accessory = new hap.Accessory('Desk', hap.uuid.generate('desk'));
    // HAP reports out-of-range values and similar mistakes as warnings: a plugin must not trigger any
    const warnings: string[] = [];
    accessory.on('characteristic-warning' as any, (_type: unknown, message: string) => warnings.push(message));
    const remembered: any[] = [];
    const platform: any = {
        api: { hap },
        log: quiet,
        locator: { locate: async () => undefined },
        remember: (id: string, changes: any) => remembered.push({ id, ...changes }),
    };
    const light: ResolvedLight = {
        id: ID, name: 'Desk', key: KEY, ip: '127.0.0.1', port: fake.port, version, lockVersion: false,
        dps: withCloudInfo ? CLOUD : undefined, minKelvin: 2700, maxKelvin: 6500,
    };
    const handler = new LightAccessory(platform, accessory as any, light);
    accessories.push(handler);
    await handler.start();

    const service = accessory.getService(Service.Lightbulb)!;
    const get = (c: any) => (service.getCharacteristic(c) as any).handleGetRequest();
    const set = (c: any, value: any) => (service.getCharacteristic(c) as any).handleSetRequest(value);
    const connected = async () => {
        for (let i = 0; i < 100; i++) {
            try {
                await get(Characteristic.On);
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 20));
            }
        }
        throw new Error('the light never became readable');
    };
    return { fake, service, get, set, connected, remembered, accessory, warnings };
}

describe.each<ProtocolVersion>(['3.3', '3.5'])('LightAccessory over protocol %s', (version) => {
    it('shows the light state in HomeKit once connected', async () => {
        const { get, connected, remembered } = await setup(version);
        await connected();
        expect(await get(Characteristic.On)).toBe(false);
        expect(await get(Characteristic.Brightness)).toBe(51);
        expect(await get(Characteristic.ColorTemperature)).toBe(217);
        expect(remembered.some((r) => r.version === version)).toBe(true);
    });

    it('turns the light on from HomeKit', async () => {
        const { fake, set, connected } = await setup(version);
        await connected();
        await set(Characteristic.On, true);
        expect(fake.controls).toEqual([{ 20: true }]);
    });

    it('sends On and Brightness together as one command', async () => {
        const { fake, set, connected } = await setup(version);
        await connected();
        await Promise.all([set(Characteristic.On, true), set(Characteristic.Brightness, 100)]);
        expect(fake.controls).toEqual([{ 20: true, 22: 1000 }]);
    });

    it('sends Hue and Saturation together as one colour command', async () => {
        const { fake, set, connected } = await setup(version);
        await connected();
        await Promise.all([set(Characteristic.Hue, 120), set(Characteristic.Saturation, 100)]);
        expect(fake.controls).toHaveLength(1);
        expect(fake.controls[0]).toMatchObject({ 21: 'colour', 24: '007803e801fe' });
    });

    it('switches back to white when a colour temperature is chosen', async () => {
        const { fake, set, connected } = await setup(version);
        await connected();
        await set(Characteristic.ColorTemperature, 154);
        expect(fake.controls).toEqual([{ 21: 'white', 23: 1000 }]);
    });

    it('follows a change made elsewhere (wall switch, Smart Life app)', async () => {
        const { fake, get, connected } = await setup(version);
        await connected();
        fake.push({ 20: true, 22: 1000 });
        await new Promise((r) => setTimeout(r, 100));
        expect(await get(Characteristic.On)).toBe(true);
        expect(await get(Characteristic.Brightness)).toBe(100);
    });

    it('reports "no response" instead of stale data while the light is unreachable', async () => {
        const { fake, get, set, connected } = await setup(version);
        await connected();
        await fake.close();
        fakes.pop();
        await new Promise((r) => setTimeout(r, 200));
        await expect(get(Characteristic.On)).rejects.toBeDefined();
        await expect(set(Characteristic.On, true)).rejects.toBeDefined();
    });
});

describe('HAP warnings', () => {
    it.each([[true], [false]])('does not make HomeKit complain about values out of range (cloud information: %s)', async (cloud) => {
        const { connected, set, get, warnings } = await setup('3.3', cloud);
        await connected();
        await set(Characteristic.Brightness, 100);
        await set(Characteristic.ColorTemperature, 154);
        await get(Characteristic.Brightness);
        await get(Characteristic.ColorTemperature);
        expect(warnings).toEqual([]);
    });
});

describe('LightAccessory without cloud information', () => {
    it('works out what the light can do from its own data points', async () => {
        const { get, connected, service } = await setup('3.3', false);
        await connected();
        expect(await get(Characteristic.Brightness)).toBe(51);
        expect(service.testCharacteristic(Characteristic.Hue)).toBe(true);
        expect(service.testCharacteristic(Characteristic.ColorTemperature)).toBe(true);
    });
});
