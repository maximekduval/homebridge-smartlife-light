import { describe, expect, it } from 'vitest';
import { findPreset, resolveExtras } from '../src/extras';
import { resolveLights } from '../src/config';
import { StoredDevice } from '../src/store';

const PROJECTOR = 'hi3ejekqmmgajyxz'; // what the setup saves: the cloud's product_id
const preset = findPreset(PROJECTOR);

describe('preset', () => {
    it('is found by the Tuya product id only', () => {
        expect(preset?.name).toBe('Smart Star Projector');
        expect(findPreset('keypaujpukpnpy8s')).toBe(preset); // the id the lamp announces on the network
        expect(findPreset('something-else')).toBeUndefined();
        expect(findPreset(undefined)).toBeUndefined();
    });

    it('gives the projector a master switch, its stars, nebula and rotation', () => {
        const { extras, problems } = resolveExtras(preset, undefined);
        expect(problems).toEqual([]);
        expect(extras).toEqual([
            { type: 'all', dp: 20, name: 'All', brightnessDp: undefined, min: 0, max: 1000, powerOn: false },
            { type: 'light', dp: 102, name: 'Stars', brightnessDp: 22, min: 10, max: 1000, powerOn: true, hue: 120, saturation: 100 },
            { type: 'switch', dp: 103, name: 'Nebula', brightnessDp: undefined, min: 0, max: 1000, powerOn: true },
            { type: 'fan', dp: 101, name: 'Rotation', brightnessDp: undefined, min: 0, max: 1000, powerOn: true },
        ]);
    });
});

describe('resolveExtras', () => {
    it('lets the user rename a preset extra without repeating the rest', () => {
        const { extras } = resolveExtras(preset, [{ dp: 102, name: 'Étoiles' }]);
        expect(extras.find((e) => e.dp === 102)).toMatchObject({ name: 'Étoiles', type: 'light', brightnessDp: 22, powerOn: true });
    });

    it('ignores empty form fields instead of erasing preset values', () => {
        const { extras } = resolveExtras(preset, [{ dp: 102, name: '', brightnessDp: null, min: '' }]);
        expect(extras.find((e) => e.dp === 102)).toMatchObject({ name: 'Stars', brightnessDp: 22, min: 10 });
    });

    it('hides an extra', () => {
        const { extras } = resolveExtras(preset, [{ dp: 103, exclude: true }]);
        expect(extras.map((e) => e.dp)).toEqual([20, 102, 101]);
    });

    it('lets the user rename or hide the master switch like any other extra', () => {
        expect(resolveExtras(preset, [{ dp: 20, name: 'Tout' }]).extras[0]).toMatchObject({ type: 'all', name: 'Tout' });
        expect(resolveExtras(preset, [{ dp: 20, exclude: true }]).extras.map((e) => e.dp)).toEqual([102, 103, 101]);
    });

    it('adds a master switch to a lamp without preset', () => {
        const { extras } = resolveExtras(undefined, [{ dp: 20, type: 'all' }, { dp: 104, type: 'switch', name: 'Night' }]);
        expect(extras.map((e) => `${e.type}:${e.name}`)).toEqual(['all:All', 'switch:Night']);
    });

    it('adds an extra to a light that has no preset', () => {
        const { extras, problems } = resolveExtras(undefined, [{ dp: 104, type: 'switch', name: 'Night mode' }]);
        expect(problems).toEqual([]);
        expect(extras).toEqual([{ type: 'switch', dp: 104, name: 'Night mode', brightnessDp: undefined, min: 0, max: 1000, powerOn: false }]);
    });

    it('takes the range of a data point from what the cloud reported', () => {
        const { extras } = resolveExtras(undefined, [{ dp: 5, type: 'fan', name: 'Speed' }], [{ id: 5, code: 'fan_speed', min: 1, max: 6 }]);
        expect(extras[0]).toMatchObject({ min: 1, max: 6 });
    });

    it('reports mistakes and keeps going', () => {
        const { extras, problems } = resolveExtras(undefined, [
            { name: 'no dp' },
            { dp: 7, type: 'toaster' },
            { dp: 8, type: 'fan', min: 10, max: 5 },
        ]);
        expect(problems).toHaveLength(3);
        expect(extras).toEqual([expect.objectContaining({ dp: 8, min: 0, max: 1000 })]);
    });
});

describe('resolveLights with a known product', () => {
    const lamp = (extra: Partial<StoredDevice> = {}): StoredDevice => ({
        id: 'a1', name: 'Nebula Glow', localKey: '0123456789abcdef', category: 'dj', productId: PROJECTOR, ...extra,
    });

    it('applies the preset without any configuration', () => {
        const { lights } = resolveLights([lamp()]);
        expect(lights[0].whiteBrightness).toBe(false);
        expect(lights[0].extras.map((e) => e.name)).toEqual(['All', 'Stars', 'Nebula', 'Rotation']);
    });

    it('leaves ordinary lights alone', () => {
        const { lights } = resolveLights([lamp({ productId: 'keyordinarybulb' })]);
        expect(lights[0].whiteBrightness).toBe(true);
        expect(lights[0].extras).toEqual([]);
    });

    it('takes the extras of the configuration and prefixes their problems with the light name', () => {
        const { lights, problems } = resolveLights([lamp()], [{ id: 'a1', extras: [{ dp: 102, name: 'Étoiles' }, { dp: 9, type: 'nope' }] as any }]);
        expect(lights[0].extras.find((e) => e.dp === 102)?.name).toBe('Étoiles');
        expect(problems).toEqual([expect.stringMatching(/^Nebula Glow: Extra on data point 9/)]);
    });
});

describe('fixed colour of a light', () => {
    it('gives the stars of the projector a green tile', () => {
        expect(resolveExtras(preset, undefined).extras.find((e) => e.dp === 102)).toMatchObject({ hue: 120, saturation: 100 });
    });

    it('can be changed or kept by the user', () => {
        expect(resolveExtras(preset, [{ dp: 102, hue: 200, saturation: 40 }]).extras.find((e) => e.dp === 102)).toMatchObject({ hue: 200, saturation: 40 });
        expect(resolveExtras(preset, [{ dp: 102, hue: 200 }]).extras.find((e) => e.dp === 102)).toMatchObject({ hue: 200, saturation: 100 });
    });

    it('applies to lights only, and rejects an impossible hue', () => {
        const { extras, problems } = resolveExtras(undefined, [{ dp: 5, type: 'switch', hue: 120 }, { dp: 6, type: 'light', hue: 500 }]);
        expect(extras.map((e) => e.hue)).toEqual([undefined, undefined]);
        expect(problems).toEqual([expect.stringMatching(/"hue" must be between 0 and 360/)]);
    });
});
