import { describe, expect, it } from 'vitest';
import {
    DpInfo, LightProfile, LightState, brightnessToHomeKit, brightnessToTuya, buildDps, buildProfile, colorTempToHomeKit,
    colorTempToTuya, detectColorFormat, formatColor, hsvToRgb, miredBounds, parseColor, readState,
} from '../src/tuya/light';

// What the cloud reports for a typical v2 light (category "dj").
const CLOUD_V2: DpInfo[] = [
    { id: 20, code: 'switch_led', type: 'Boolean' },
    { id: 21, code: 'work_mode', type: 'Enum' },
    { id: 22, code: 'bright_value_v2', type: 'Integer', min: 10, max: 1000 },
    { id: 23, code: 'temp_value_v2', type: 'Integer', min: 0, max: 1000 },
    { id: 24, code: 'colour_data_v2', type: 'Json' },
    { id: 25, code: 'scene_data_v2', type: 'Json' },
];

const LIVE_V2 = { 20: true, 21: 'white', 22: 505, 23: 500, 24: '000003e803e8' };

function profileV2(): LightProfile {
    return buildProfile(CLOUD_V2, LIVE_V2)!;
}

describe('profile detection', () => {
    it('uses the data points and ranges reported by the cloud', () => {
        expect(profileV2()).toMatchObject({
            on: 20, mode: 21,
            brightness: { dp: 22, min: 10, max: 1000 },
            colorTemp: { dp: 23, min: 0, max: 1000 },
            color: { dp: 24, format: 'hsv12', sMax: 1000, vMax: 1000 },
        });
    });

    it('guesses a v2 light from its data points when the cloud said nothing', () => {
        expect(buildProfile(undefined, LIVE_V2)).toMatchObject({ on: 20, brightness: { dp: 22 }, color: { format: 'hsv12' } });
    });

    it('guesses a v1 light and its 14-digit colour format', () => {
        const live = { 1: true, 2: 'colour', 3: 255, 4: 0, 5: 'ff0000' + '0000' + 'ff' + 'ff' };
        expect(buildProfile(undefined, live)).toMatchObject({
            on: 1, mode: 2, brightness: { dp: 3, min: 25, max: 255 }, colorTemp: { dp: 4, max: 255 },
            color: { dp: 5, format: 'rgbhsv14', sMax: 255 },
        });
    });

    it('handles a white-only light', () => {
        const profile = buildProfile([{ id: 1, code: 'switch_led' }, { id: 3, code: 'bright_value', min: 25, max: 255 }], { 1: true, 3: 100 })!;
        expect(profile.color).toBeUndefined();
        expect(profile.colorTemp).toBeUndefined();
    });

    it('refuses a device that is not a light', () => {
        expect(buildProfile(undefined, { 101: 'x', 102: 3 })).toBeNull();
        expect(buildProfile([{ id: 1, code: 'va_temperature' }], {})).toBeNull();
    });

    it('recognises the colour format from the value itself', () => {
        expect(detectColorFormat('colour_data', '{"h":1,"s":2,"v":3}')).toBe('json');
        expect(detectColorFormat('colour_data', '000003e803e8')).toBe('hsv12');
        expect(detectColorFormat('colour_data_v2', 'ff00000000ffff')).toBe('rgbhsv14');
        expect(detectColorFormat('colour_data_v2', undefined)).toBe('hsv12');
        expect(detectColorFormat('colour_data', undefined)).toBe('rgbhsv14');
    });
});

describe('brightness scale', () => {
    it.each([[10, 1], [1000, 100], [505, 51]])('maps raw %i to %i%%', (raw, pct) => {
        expect(brightnessToHomeKit(raw, 10, 1000)).toBe(pct);
    });

    it('never goes below 1% or above the lamp maximum', () => {
        expect(brightnessToHomeKit(0, 10, 1000)).toBe(1);
        expect(brightnessToTuya(0, 10, 1000)).toBe(10);
        expect(brightnessToTuya(100, 10, 1000)).toBe(1000);
        expect(brightnessToTuya(150, 25, 255)).toBe(255);
    });

    it('survives a round trip for every percentage', () => {
        for (let pct = 1; pct <= 100; pct++) {
            expect(brightnessToHomeKit(brightnessToTuya(pct, 10, 1000), 10, 1000)).toBe(pct);
            expect(brightnessToHomeKit(brightnessToTuya(pct, 25, 255), 25, 255)).toBe(pct);
        }
    });
});

describe('colour temperature', () => {
    const profile = profileV2();
    const p = profile.colorTemp!;

    it('uses HomeKit mired bounds matching 2700K-6500K', () => {
        expect(miredBounds(profile)).toEqual({ min: 154, max: 370 });
    });

    it('maps warm and cool ends of the scale', () => {
        expect(colorTempToHomeKit(0, p, profile)).toBe(370); // warmest
        expect(colorTempToHomeKit(1000, p, profile)).toBe(154); // coolest
        expect(colorTempToTuya(370, p, profile)).toBe(0);
        expect(colorTempToTuya(154, p, profile)).toBe(1000);
    });

    it('round-trips within one step', () => {
        for (let mired = 154; mired <= 370; mired += 7) {
            const back = colorTempToHomeKit(colorTempToTuya(mired, p, profile), p, profile);
            expect(Math.abs(back - mired)).toBeLessThanOrEqual(2);
        }
    });

    it('clamps values outside the lamp range', () => {
        expect(colorTempToTuya(50, p, profile)).toBe(1000);
        expect(colorTempToTuya(900, p, profile)).toBe(0);
    });
});

describe('colour', () => {
    it('converts HSV to RGB', () => {
        expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
        expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
        expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
        expect(hsvToRgb(60, 1, 1)).toEqual([255, 255, 0]);
        expect(hsvToRgb(0, 0, 1)).toEqual([255, 255, 255]);
    });

    it('writes and reads the 12-digit v2 format', () => {
        const color = profileV2().color!;
        const raw = formatColor(color, { h: 240, s: 100, v: 50 });
        expect(raw).toBe('00f003e801f4');
        expect(parseColor(color, raw)).toEqual({ h: 240, s: 100, v: 50 });
    });

    it('writes and reads the 14-digit v1 format with full-brightness RGB in front', () => {
        const color = buildProfile(undefined, { 1: true, 2: 'colour', 3: 100, 5: '00000000000000' })!.color!;
        const raw = formatColor(color, { h: 120, s: 100, v: 50 });
        expect(raw).toBe('00ff00' + '0078' + 'ff' + '80');
        const back = parseColor(color, raw)!;
        expect(back.h).toBe(120);
        expect(Math.round(back.v)).toBe(50);
    });

    it('reads the JSON format some lights use', () => {
        const color = { dp: 24, format: 'json' as const, sMax: 1000, vMax: 1000 };
        expect(parseColor(color, '{"h":30,"s":500,"v":1000}')).toEqual({ h: 30, s: 50, v: 100 });
        expect(JSON.parse(formatColor(color, { h: 30, s: 50, v: 100 }))).toEqual({ h: 30, s: 500, v: 1000 });
    });

    it('ignores values it cannot understand', () => {
        const color = profileV2().color!;
        expect(parseColor(color, 'zz')).toBeNull();
        expect(parseColor(color, 12)).toBeNull();
    });
});

describe('reading the light state', () => {
    const profile = profileV2();

    it('reads a white light', () => {
        expect(readState(profile, LIVE_V2)).toMatchObject({ on: true, mode: 'white', brightness: 51, colorTemperature: 217 });
    });

    it('reads brightness from the colour value in colour mode', () => {
        const state = readState(profile, { ...LIVE_V2, 21: 'colour', 24: '00780320' + '01f4' });
        expect(state).toMatchObject({ mode: 'colour', hue: 120, saturation: 80, brightness: 50 });
    });

    it('keeps the previous values for data points that are missing', () => {
        const previous = readState(profile, LIVE_V2);
        const next = readState(profile, { 20: false }, previous);
        expect(next).toMatchObject({ on: false, brightness: 51, colorTemperature: 217 });
    });

    it('treats scene and music modes as white', () => {
        expect(readState(profile, { ...LIVE_V2, 21: 'scene' }).mode).toBe('white');
    });
});

describe('building commands for HomeKit changes', () => {
    const profile = profileV2();
    const white: LightState = { on: true, brightness: 50, mode: 'white', colorTemperature: 262, hue: 0, saturation: 100 };
    const colour: LightState = { ...white, mode: 'colour', hue: 200, saturation: 60 };

    it('turns the light on and off', () => {
        expect(buildDps(profile, { on: true }, white)).toEqual({ 20: true });
        expect(buildDps(profile, { on: false }, white)).toEqual({ 20: false });
    });

    it('sets brightness on the white channel in white mode', () => {
        expect(buildDps(profile, { brightness: 100 }, white)).toEqual({ 22: 1000 });
    });

    it('sets brightness inside the colour value in colour mode, without leaving colour mode', () => {
        const dps = buildDps(profile, { brightness: 100 }, colour);
        expect(dps).toEqual({ 24: formatColor(profile.color!, { h: 200, s: 60, v: 100 }) });
        expect(dps[21]).toBeUndefined();
    });

    it('switches to colour mode when hue and saturation are set', () => {
        const dps = buildDps(profile, { hue: 120, saturation: 100 }, white);
        expect(dps).toEqual({ 21: 'colour', 24: formatColor(profile.color!, { h: 120, s: 100, v: 50 }) });
    });

    it('keeps the missing half when only the hue changes', () => {
        const dps = buildDps(profile, { hue: 10 }, colour);
        expect(dps[24]).toBe(formatColor(profile.color!, { h: 10, s: 60, v: 50 }));
    });

    it('switches to white mode when the colour temperature is set', () => {
        expect(buildDps(profile, { colorTemperature: 154 }, colour)).toEqual({ 21: 'white', 23: 1000 });
    });

    it('combines on + brightness in a single command', () => {
        expect(buildDps(profile, { on: true, brightness: 20 }, { ...white, on: false })).toEqual({ 20: true, 22: 200 });
    });

    it('adapts to a white-only light', () => {
        const plain = buildProfile([{ id: 1, code: 'switch_led' }, { id: 3, code: 'bright_value', min: 25, max: 255 }], { 1: true, 3: 100 })!;
        expect(buildDps(plain, { hue: 100, saturation: 100 }, white)).toEqual({});
        expect(buildDps(plain, { brightness: 100 }, white)).toEqual({ 3: 255 });
    });
});
