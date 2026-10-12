import { describe, expect, it } from 'vitest';
import { isLight, resolveLights } from '../src/config';
import { StoredDevice } from '../src/store';

const stored = (extra: Partial<StoredDevice> = {}): StoredDevice => ({ id: 'a1', name: 'Desk', localKey: '0123456789abcdef', category: 'dj', ...extra });

describe('isLight', () => {
    it('recognises light categories and the switch data point', () => {
        expect(isLight({ category: 'dj' })).toBe(true);
        expect(isLight({ category: 'xdd' })).toBe(true);
        expect(isLight({ category: 'cz' })).toBe(false); // a socket
        expect(isLight({ category: 'mcs', dps: [{ id: 1, code: 'doorcontact_state' }] })).toBe(false);
        expect(isLight({ category: 'unknown', dps: [{ id: 20, code: 'switch_led' }] })).toBe(true);
    });

    it('trusts a device declared by hand', () => {
        expect(isLight({})).toBe(true);
    });
});

describe('resolveLights', () => {
    it('uses what the setup saved, with sensible defaults', () => {
        const { lights, problems } = resolveLights([stored({ ip: '192.168.1.50', version: '3.3' })]);
        expect(problems).toEqual([]);
        expect(lights).toEqual([expect.objectContaining({
            id: 'a1', name: 'Desk', key: '0123456789abcdef', ip: '192.168.1.50', version: '3.3', lockVersion: false, minKelvin: 2700, maxKelvin: 6500,
        })]);
    });

    it('lets the configuration rename, pin the IP and lock the protocol version', () => {
        const { lights } = resolveLights([stored()], [{ id: 'a1', name: 'Reading lamp', ip: '10.0.0.9', version: '3.4', minKelvin: 2200 }]);
        expect(lights[0]).toMatchObject({ name: 'Reading lamp', ip: '10.0.0.9', version: '3.4', lockVersion: true, minKelvin: 2200 });
    });

    it('accepts a numeric version, as people write it in JSON', () => {
        const { lights } = resolveLights([stored()], [{ id: 'a1', version: 3.5 }]);
        expect(lights[0]).toMatchObject({ version: '3.5', lockVersion: true });
    });

    it('reports an invalid version but still exposes the light', () => {
        const { lights, problems } = resolveLights([stored()], [{ id: 'a1', version: '4.0' }]);
        expect(lights).toHaveLength(1);
        expect(lights[0].lockVersion).toBe(false);
        expect(problems[0]).toMatch(/version/);
    });

    it('declares a light entirely in the configuration, without any cloud', () => {
        const { lights } = resolveLights([], [{ id: 'bf99', key: 'fedcba9876543210', name: 'Hallway', ip: '192.168.1.60' }]);
        expect(lights[0]).toMatchObject({ id: 'bf99', name: 'Hallway', key: 'fedcba9876543210', ip: '192.168.1.60' });
    });

    it('skips excluded lights and devices that are not lights', () => {
        const { lights, skipped } = resolveLights(
            [stored(), stored({ id: 'b2', name: 'Plug', category: 'cz' }), stored({ id: 'c3', name: 'Closet' })],
            [{ id: 'c3', exclude: true }],
        );
        expect(lights.map((l) => l.id)).toEqual(['a1']);
        expect(skipped).toHaveLength(2);
    });

    it('explains a missing or malformed key', () => {
        const { lights, problems } = resolveLights([stored({ localKey: '' }), stored({ id: 'b2', name: 'Short', localKey: 'abc' })], [{ id: 'zz' }]);
        expect(lights).toEqual([]);
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toMatch(/no local key/);
        expect(problems.join('\n')).toMatch(/16 characters/);
    });
});

describe('resolveLights with the Homebridge UI form', () => {
    it('treats an empty protocol version ("Automatic") as not set', () => {
        const { lights, problems } = resolveLights([stored()], [{ id: 'a1', version: '' }]);
        expect(problems).toEqual([]);
        expect(lights[0].lockVersion).toBe(false);
    });
});
