import { afterEach, describe, expect, it } from 'vitest';
import * as hap from 'hap-nodejs';
import { LightAccessory } from '../src/accessory/LightAccessory';
import { ResolvedLight } from '../src/config';
import { findPreset, resolveExtras } from '../src/extras';
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

interface SetupOptions {
    dps?: Record<string, unknown>;
    cloud?: DpInfo[];
    light?: Partial<ResolvedLight>;
}

async function setup(version: ProtocolVersion, withCloudInfo = true, options: SetupOptions = {}) {
    const fake = new FakeTuyaDevice(ID, KEY, version, options.dps ?? { 20: false, 21: 'white', 22: 505, 23: 500, 24: '000003e803e8' });
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
        dps: withCloudInfo ? (options.cloud ?? CLOUD) : undefined, minKelvin: 2700, maxKelvin: 6500, whiteBrightness: true, extras: [],
        ...options.light,
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

// ---------------------------------------------------------------------------------------------
// A star projector, behaving like the real one (see the measurements in src/extras.ts)
// ---------------------------------------------------------------------------------------------

const PROJECTOR_CLOUD: DpInfo[] = [
    { id: 20, code: 'switch_led' }, { id: 21, code: 'work_mode' }, { id: 22, code: 'bright_value_v2', min: 10, max: 1000 },
    { id: 24, code: 'colour_data_v2' }, { id: 25, code: 'scene_data_v2' }, { id: 26, code: 'countdown_1' },
];

const PROJECTOR_DPS = {
    20: true, 21: 'colour', 22: 161, 24: '00ed03e8017e', 25: '0746460000dd03e8009600000000', 26: 0, 101: 1000, 102: true, 103: true,
};

async function projector(dps: Record<string, unknown> = PROJECTOR_DPS) {
    const { extras } = resolveExtras(findPreset('hi3ejekqmmgajyxz'), undefined, PROJECTOR_CLOUD);
    const harness = await setup('3.3', true, { dps, cloud: PROJECTOR_CLOUD, light: { whiteBrightness: false, extras } });
    // what the real lamp does by itself
    harness.fake.quirks = (asked) => {
        const side: Record<string, unknown> = {};
        if (asked[20] === false) {
            Object.assign(side, { 102: false, 103: false });
        } else if (asked[20] === true && !('102' in asked) && !('103' in asked)) {
            Object.assign(side, { 102: true, 103: true });
        }
        if (asked[103] === true) {
            side[21] = 'colour';
        }
        return side;
    };
    const tile = (type: any, id: string) => harness.accessory.getServiceById(type, id)!;
    const stars = tile(Service.Lightbulb, 'extra-102');
    const nebula = tile(Service.Switch, 'extra-103');
    const rotation = tile(Service.Fanv2, 'extra-101');
    const all = tile(Service.Switch, 'extra-20');
    const act = (service: any, c: any, value?: any) => (value === undefined
        ? (service.getCharacteristic(c) as any).handleGetRequest()
        : (service.getCharacteristic(c) as any).handleSetRequest(value));
    return { ...harness, stars, nebula, rotation, all, act };
}

describe('star projector master switch', () => {
    const settle = () => new Promise((r) => setTimeout(r, 100));

    it('shows "on" only when the lamp is on and the stars, nebula and rotation all are', async () => {
        const { all, act, connected, fake } = await projector();
        await connected();
        expect(await act(all, Characteristic.On)).toBe(true);
        fake.push({ 102: false });
        await settle();
        expect(await act(all, Characteristic.On)).toBe(false);
        fake.push({ 102: true, 101: 0 });
        await settle();
        expect(await act(all, Characteristic.On)).toBe(false); // the rotation is stopped
        fake.push({ 101: 300 });
        await settle();
        expect(await act(all, Characteristic.On)).toBe(true);
    });

    it('switches everything on with one tap from a partial state, and resumes the rotation', async () => {
        const { fake, all, act, connected } = await projector({ ...PROJECTOR_DPS, 102: false, 101: 0 });
        await connected();
        await act(all, Characteristic.On, true);
        expect(fake.controls).toEqual([{ 20: true, 102: true, 101: 1000 }]);
    });

    it('resumes the rotation at the speed it had before it was stopped', async () => {
        const { fake, all, act, connected } = await projector({ ...PROJECTOR_DPS, 101: 400 });
        await connected();
        fake.push({ 101: 0 });
        await settle();
        await act(all, Characteristic.On, true);
        expect(fake.controls[0]).toMatchObject({ 20: true, 101: 400 });
    });

    it('leaves a running rotation alone', async () => {
        const { fake, all, act, connected } = await projector({ ...PROJECTOR_DPS, 102: false, 101: 500 });
        await connected();
        await act(all, Characteristic.On, true);
        expect(fake.controls).toEqual([{ 20: true, 102: true }]);
    });

    it('powers the lamp on and brings everything up from standby', async () => {
        const { fake, all, act, connected } = await projector({ ...PROJECTOR_DPS, 20: false, 102: false, 103: false, 101: 0 });
        await connected();
        await act(all, Characteristic.On, true);
        expect(fake.controls).toEqual([{ 20: true, 102: true, 103: true, 101: 1000 }]);
    });

    it('switches everything off by switching the lamp off', async () => {
        const { fake, all, act, connected } = await projector();
        await connected();
        await act(all, Characteristic.On, false);
        expect(fake.controls).toEqual([{ 20: false }]);
        await settle();
        expect(await act(all, Characteristic.On)).toBe(false);
    });
});

describe('star projector', () => {
    it('shows the lamp, the stars, the nebula and the rotation as tiles of one accessory', async () => {
        const { accessory, connected } = await projector();
        await connected();
        const lights = accessory.services.filter((s) => s.UUID === Service.Lightbulb.UUID);
        expect(lights.map((s) => s.subtype ?? 'main')).toEqual(['main', 'extra-102']);
        expect(accessory.getServiceById(Service.Switch, 'extra-20')).toBeDefined(); // the master switch
        expect(accessory.getServiceById(Service.Switch, 'extra-103')).toBeDefined();
        expect(accessory.getServiceById(Service.Fanv2, 'extra-101')).toBeDefined();
        expect(accessory.getService(Service.Lightbulb)?.isPrimaryService).toBe(true);
    });

    it('uses the brightness of the colour, not the stars, as the main brightness', async () => {
        const { get, connected } = await projector();
        await connected();
        expect(await get(Characteristic.Brightness)).toBe(38); // 0x17e = 382 of 1000, not the 161 of the stars
        expect(await get(Characteristic.Hue)).toBe(237);
    });

    it('shows the stars as a light with their own intensity', async () => {
        const { stars, act, connected } = await projector();
        await connected();
        expect(await act(stars, Characteristic.On)).toBe(true);
        expect(await act(stars, Characteristic.Brightness)).toBe(16); // 161 on a 10..1000 scale
    });

    it('shows the stars in a fixed green that cannot be changed', async () => {
        const { stars, act, connected, warnings } = await projector();
        await connected();
        expect(await act(stars, Characteristic.Hue)).toBe(120);
        expect(await act(stars, Characteristic.Saturation)).toBe(100);
        expect(stars.getCharacteristic(Characteristic.Hue).props.perms).not.toContain('pw');
        expect(warnings).toEqual([]);
    });

    it('turns the stars off and sets their intensity without touching anything else', async () => {
        const { fake, stars, act, connected } = await projector();
        await connected();
        await act(stars, Characteristic.On, false);
        await act(stars, Characteristic.Brightness, 100);
        await act(stars, Characteristic.Brightness, 1);
        expect(fake.controls).toEqual([{ 102: false }, { 22: 1000 }, { 22: 10 }]);
    });

    it('powers the lamp on when the nebula is switched on from standby', async () => {
        const { fake, nebula, act, connected } = await projector({ ...PROJECTOR_DPS, 20: false, 102: false, 103: false });
        await connected();
        await act(nebula, Characteristic.On, true);
        expect(fake.controls).toEqual([{ 20: true, 103: true }]);
    });

    it('does not touch the power when the lamp is already on', async () => {
        const { fake, nebula, act, connected } = await projector();
        await connected();
        await act(nebula, Characteristic.On, false);
        expect(fake.controls).toEqual([{ 103: false }]);
    });

    it('sets the rotation speed on its own scale and stops it at 0%', async () => {
        const { fake, rotation, act, connected } = await projector();
        await connected();
        await act(rotation, Characteristic.RotationSpeed, 30);
        await act(rotation, Characteristic.RotationSpeed, 0);
        expect(fake.controls).toEqual([{ 101: 300 }, { 101: 0 }]);
    });

    it('stops the rotation when switched off and resumes at the previous speed when switched on', async () => {
        const { fake, rotation, act, connected } = await projector({ ...PROJECTOR_DPS, 101: 400 });
        await connected();
        await act(rotation, Characteristic.Active, 0);
        await act(rotation, Characteristic.Active, 1);
        expect(fake.controls).toEqual([{ 101: 0 }, { 101: 400 }]);
    });

    it('lets an explicit speed win over the resume speed when both arrive together', async () => {
        const { fake, rotation, act, connected } = await projector({ ...PROJECTOR_DPS, 101: 0 });
        await connected();
        await Promise.all([act(rotation, Characteristic.Active, 1), act(rotation, Characteristic.RotationSpeed, 70)]);
        expect(fake.controls).toEqual([{ 101: 700 }]);
        await Promise.all([act(rotation, Characteristic.RotationSpeed, 20), act(rotation, Characteristic.Active, 1)]);
        expect(fake.controls[1]).toEqual({ 101: 200 });
    });

    it('shows the rotation as stopped or running', async () => {
        const { rotation, act, connected, fake } = await projector();
        await connected();
        expect(await act(rotation, Characteristic.Active)).toBe(1);
        expect(await act(rotation, Characteristic.RotationSpeed)).toBe(100);
        fake.push({ 101: 0 });
        await new Promise((r) => setTimeout(r, 100));
        expect(await act(rotation, Characteristic.Active)).toBe(0);
    });

    it('follows what happens on the lamp or in the Smart Life app', async () => {
        const { stars, nebula, act, connected, fake, get } = await projector();
        await connected();
        fake.push({ 102: false, 103: false, 22: 505, 20: false });
        await new Promise((r) => setTimeout(r, 100));
        expect(await act(stars, Characteristic.On)).toBe(false);
        expect(await act(stars, Characteristic.Brightness)).toBe(51);
        expect(await act(nebula, Characteristic.On)).toBe(false);
        expect(await get(Characteristic.On)).toBe(false);
    });

    it('colours the nebula with Hue and Saturation, at the current brightness', async () => {
        const { fake, set, connected } = await projector();
        await connected();
        await Promise.all([set(Characteristic.Hue, 120), set(Characteristic.Saturation, 100)]);
        expect(fake.controls[0]).toEqual({ 21: 'colour', 24: '007803e8017c' });
    });

    it('switches from the stars mode back to the colour when the main brightness is changed', async () => {
        const { fake, set, connected } = await projector({ ...PROJECTOR_DPS, 21: 'white' });
        await connected();
        await set(Characteristic.Brightness, 100);
        expect(fake.controls[0]).toEqual({ 24: '00ed03e803e8', 21: 'colour' });
    });

    it('does not make HomeKit complain about anything', async () => {
        const { connected, warnings, act, stars, rotation } = await projector();
        await connected();
        await act(stars, Characteristic.Brightness, 1);
        await act(rotation, Characteristic.RotationSpeed, 100);
        await act(rotation, Characteristic.RotationSpeed, 0);
        expect(warnings).toEqual([]);
    });
});
