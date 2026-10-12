/**
 * Translates between Tuya light data points and HomeKit values.
 *
 * Tuya lights come in two generations that use different data point (DP) numbers and ranges:
 *
 *   code              v2 (most lights since ~2019)        v1 (older lights)
 *   switch_led        dp 20, boolean                       dp 1
 *   work_mode         dp 21, "white" | "colour" | ...      dp 2
 *   bright_value      dp 22, 10..1000                      dp 3, 25..255
 *   temp_value        dp 23, 0..1000 (0 = warm)            dp 4, 0..255
 *   colour_data       dp 24, "hhhhssssvvvv" hex            dp 5, "rrggbbhhhhssvv" hex
 *
 * The cloud tells us the exact numbers and ranges of each light (see cloud/sharing.ts); when it does not, we guess
 * from which DPs the light reports. Everything here is pure so it can be tested without a device.
 */
import { Dps } from './protocol';

export interface DpInfo {
    id: number;
    code: string;
    type?: string;
    min?: number;
    max?: number;
}

export type ColorFormat = 'hsv12' | 'rgbhsv14' | 'json';

export interface LightProfile {
    on: number;
    mode?: number;
    brightness?: { dp: number; min: number; max: number };
    colorTemp?: { dp: number; min: number; max: number };
    color?: { dp: number; format: ColorFormat; sMax: number; vMax: number };
    /** Colour temperature range of the lamp, used to convert Tuya's 0..max scale to HomeKit's mireds. */
    minKelvin: number;
    maxKelvin: number;
}

export interface LightState {
    on: boolean;
    /** 0..100 */
    brightness: number;
    /** mireds */
    colorTemperature?: number;
    /** 0..360 */
    hue?: number;
    /** 0..100 */
    saturation?: number;
    mode: 'white' | 'colour';
}

export type LightPatch = Partial<Omit<LightState, 'mode'>>;

const DEFAULT_KELVIN = { min: 2700, max: 6500 };

// ---------------------------------------------------------------------------------------------
// Profile detection
// ---------------------------------------------------------------------------------------------

const CODES = {
    on: ['switch_led', 'switch_led_1', 'switch'],
    mode: ['work_mode'],
    brightness: ['bright_value_v2', 'bright_value', 'bright_value_1'],
    colorTemp: ['temp_value_v2', 'temp_value', 'temp_value_1'],
    color: ['colour_data_v2', 'colour_data', 'colour_data_1'],
};

const LAYOUT_V2 = {
    on: 20, mode: 21,
    brightness: { dp: 22, min: 10, max: 1000 },
    colorTemp: { dp: 23, min: 0, max: 1000 },
    color: { dp: 24, code: 'colour_data_v2' },
};

const LAYOUT_V1 = {
    on: 1, mode: 2,
    brightness: { dp: 3, min: 25, max: 255 },
    colorTemp: { dp: 4, min: 0, max: 255 },
    color: { dp: 5, code: 'colour_data' },
};

function find(infos: DpInfo[], codes: string[]): DpInfo | undefined {
    for (const code of codes) {
        const hit = infos.find((i) => i.code === code);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

export function detectColorFormat(code: string, live: unknown): ColorFormat {
    if (typeof live === 'string') {
        if (live.trim().startsWith('{')) {
            return 'json';
        }
        if (/^[0-9a-f]{12}$/i.test(live)) {
            return 'hsv12';
        }
        if (/^[0-9a-f]{14}$/i.test(live)) {
            return 'rgbhsv14';
        }
    }
    return code.endsWith('_v2') ? 'hsv12' : 'rgbhsv14';
}

function colorRanges(format: ColorFormat, code: string): { sMax: number; vMax: number } {
    if (format === 'hsv12') {
        return { sMax: 1000, vMax: 1000 };
    }
    if (format === 'rgbhsv14') {
        return { sMax: 255, vMax: 255 };
    }
    return code.endsWith('_v2') ? { sMax: 1000, vMax: 1000 } : { sMax: 255, vMax: 255 };
}

/**
 * Builds the profile of a light from what the cloud told us (`infos`, may be empty) and what the light reports (`live`).
 * Returns null when the device does not look like a light at all.
 */
export interface ProfileOptions {
    /** Set to false when the white brightness data point is something else (the intensity of the stars, say). */
    whiteBrightness?: boolean;
}

export function buildProfile(
    infos: DpInfo[] | undefined, live: Dps, kelvin = DEFAULT_KELVIN, options: ProfileOptions = {},
): LightProfile | null {
    const profile = detectProfile(infos, live, kelvin);
    if (profile && options.whiteBrightness === false) {
        delete profile.brightness;
    }
    return profile;
}

function detectProfile(infos: DpInfo[] | undefined, live: Dps, kelvin: { min: number; max: number }): LightProfile | null {
    const known = infos ?? [];
    const profile: Partial<LightProfile> = { minKelvin: kelvin.min, maxKelvin: kelvin.max };

    const on = find(known, CODES.on);
    if (on) {
        profile.on = on.id;
        const mode = find(known, CODES.mode);
        if (mode) {
            profile.mode = mode.id;
        }
        const bright = find(known, CODES.brightness);
        if (bright) {
            const v2 = bright.code.endsWith('_v2');
            profile.brightness = { dp: bright.id, min: bright.min ?? (v2 ? 10 : 25), max: bright.max ?? (v2 ? 1000 : 255) };
        }
        const temp = find(known, CODES.colorTemp);
        if (temp) {
            const v2 = temp.code.endsWith('_v2');
            profile.colorTemp = { dp: temp.id, min: temp.min ?? 0, max: temp.max ?? (v2 ? 1000 : 255) };
        }
        const color = find(known, CODES.color);
        if (color) {
            const format = detectColorFormat(color.code, live[color.id]);
            profile.color = { dp: color.id, format, ...colorRanges(format, color.code) };
        }
        return profile as LightProfile;
    }

    // No cloud information: infer the generation from the data points the light reports.
    const layout = '20' in live ? LAYOUT_V2 : (('1' in live && '2' in live) ? LAYOUT_V1 : null);
    if (!layout) {
        return null;
    }
    profile.on = layout.on;
    if (String(layout.mode) in live) {
        profile.mode = layout.mode;
    }
    if (String(layout.brightness.dp) in live) {
        profile.brightness = { ...layout.brightness };
    }
    if (String(layout.colorTemp.dp) in live) {
        profile.colorTemp = { ...layout.colorTemp };
    }
    if (String(layout.color.dp) in live) {
        const format = detectColorFormat(layout.color.code, live[layout.color.dp]);
        profile.color = { dp: layout.color.dp, format, ...colorRanges(format, layout.color.code) };
    }
    return profile as LightProfile;
}

// ---------------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const hex = (value: number, digits: number) => Math.round(value).toString(16).padStart(digits, '0');

/** `s` and `v` in 0..1, `h` in degrees. Returns 0..255 channels. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const sector = Math.floor((((h % 360) + 360) % 360) / 60);
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export interface Hsv {
    h: number; // 0..360
    s: number; // 0..100
    v: number; // 0..100
}

export function parseColor(profile: NonNullable<LightProfile['color']>, raw: unknown): Hsv | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const { sMax, vMax } = profile;
    try {
        if (profile.format === 'json' || raw.trim().startsWith('{')) {
            const o = JSON.parse(raw);
            return { h: Number(o.h), s: (Number(o.s) / sMax) * 100, v: (Number(o.v) / vMax) * 100 };
        }
        if (profile.format === 'hsv12' && raw.length === 12) {
            return {
                h: parseInt(raw.slice(0, 4), 16),
                s: (parseInt(raw.slice(4, 8), 16) / sMax) * 100,
                v: (parseInt(raw.slice(8, 12), 16) / vMax) * 100,
            };
        }
        if (profile.format === 'rgbhsv14' && raw.length === 14) {
            return {
                h: parseInt(raw.slice(6, 10), 16),
                s: (parseInt(raw.slice(10, 12), 16) / sMax) * 100,
                v: (parseInt(raw.slice(12, 14), 16) / vMax) * 100,
            };
        }
    } catch {
        // fall through
    }
    return null;
}

export function formatColor(profile: NonNullable<LightProfile['color']>, { h, s, v }: Hsv): string {
    const hue = Math.round(clamp(h, 0, 360));
    const sat = Math.round((clamp(s, 0, 100) / 100) * profile.sMax);
    const val = Math.round((clamp(v, 0, 100) / 100) * profile.vMax);
    switch (profile.format) {
        case 'json':
            return JSON.stringify({ h: hue, s: sat, v: val });
        case 'hsv12':
            return hex(hue, 4) + hex(sat, 4) + hex(val, 4);
        case 'rgbhsv14': {
            // the leading RGB is the colour at full brightness; brightness travels in the trailing "v"
            const [r, g, b] = hsvToRgb(hue, clamp(s, 0, 100) / 100, 1);
            return hex(r, 2) + hex(g, 2) + hex(b, 2) + hex(hue, 4) + hex(sat, 2) + hex(val, 2);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------------------------

/** Tuya's lowest brightness is still "on" (about 1%), so 0% never maps to raw 0. */
export function brightnessToHomeKit(raw: number, min: number, max: number): number {
    const span = Math.max(1, max - min);
    return clamp(Math.round(1 + ((raw - min) * 99) / span), 1, 100);
}

export function brightnessToTuya(percent: number, min: number, max: number): number {
    const span = max - min;
    return clamp(Math.round(min + ((clamp(percent, 1, 100) - 1) * span) / 99), min, max);
}

export function miredBounds(profile: LightProfile): { min: number; max: number } {
    return { min: Math.round(1e6 / profile.maxKelvin), max: Math.round(1e6 / profile.minKelvin) };
}

export function colorTempToHomeKit(raw: number, p: NonNullable<LightProfile['colorTemp']>, profile: LightProfile): number {
    const ratio = clamp((raw - p.min) / Math.max(1, p.max - p.min), 0, 1);
    const { min, max } = miredBounds(profile);
    // snap the ends: mired bounds are rounded, so converting them back through kelvin would land a step short
    if (ratio === 0) {
        return max;
    }
    if (ratio === 1) {
        return min;
    }
    const kelvin = profile.minKelvin + ratio * (profile.maxKelvin - profile.minKelvin);
    return clamp(Math.round(1e6 / kelvin), min, max);
}

export function colorTempToTuya(mired: number, p: NonNullable<LightProfile['colorTemp']>, profile: LightProfile): number {
    const { min, max } = miredBounds(profile);
    if (mired <= min) {
        return p.max;
    }
    if (mired >= max) {
        return p.min;
    }
    const kelvin = 1e6 / mired;
    const ratio = (kelvin - profile.minKelvin) / Math.max(1, profile.maxKelvin - profile.minKelvin);
    return clamp(Math.round(p.min + ratio * (p.max - p.min)), p.min, p.max);
}

// ---------------------------------------------------------------------------------------------
// State <-> data points
// ---------------------------------------------------------------------------------------------

const get = (dps: Dps, dp: number | undefined) => (dp === undefined ? undefined : dps[String(dp)]);

export function readState(profile: LightProfile, dps: Dps, previous?: LightState): LightState {
    const mode = get(dps, profile.mode) === 'colour' && profile.color ? 'colour' : 'white';
    const state: LightState = {
        on: Boolean(get(dps, profile.on)),
        brightness: previous?.brightness ?? 100,
        mode,
        colorTemperature: previous?.colorTemperature,
        hue: previous?.hue,
        saturation: previous?.saturation,
    };

    const colour = profile.color ? parseColor(profile.color, get(dps, profile.color.dp)) : null;
    if (colour) {
        state.hue = Math.round(colour.h);
        state.saturation = Math.round(colour.s);
    }

    const white = profile.brightness ? get(dps, profile.brightness.dp) : undefined;
    if (colour && (mode === 'colour' || !profile.brightness)) {
        state.brightness = clamp(Math.round(colour.v), 1, 100);
    } else if (typeof white === 'number' && profile.brightness) {
        state.brightness = brightnessToHomeKit(white, profile.brightness.min, profile.brightness.max);
    }

    const temp = profile.colorTemp ? get(dps, profile.colorTemp.dp) : undefined;
    if (typeof temp === 'number' && profile.colorTemp) {
        state.colorTemperature = colorTempToHomeKit(temp, profile.colorTemp, profile);
    }
    return state;
}

/** Data points to send for a change asked by HomeKit. `current` is the last known state. */
export function buildDps(profile: LightProfile, patch: LightPatch, current: LightState): Dps {
    const dps: Dps = {};
    const brightness = patch.brightness ?? current.brightness;

    if (patch.on !== undefined) {
        dps[profile.on] = patch.on;
    }

    const wantsColour = profile.color && (patch.hue !== undefined || patch.saturation !== undefined);
    const wantsWhite = profile.colorTemp && patch.colorTemperature !== undefined;

    if (wantsColour && profile.color) {
        dps[profile.color.dp] = formatColor(profile.color, {
            h: patch.hue ?? current.hue ?? 0,
            s: patch.saturation ?? current.saturation ?? 100,
            v: brightness,
        });
        if (profile.mode !== undefined) {
            dps[profile.mode] = 'colour';
        }
        return dps;
    }

    if (wantsWhite && profile.colorTemp) {
        dps[profile.colorTemp.dp] = colorTempToTuya(patch.colorTemperature!, profile.colorTemp, profile);
        if (profile.mode !== undefined) {
            dps[profile.mode] = 'white';
        }
        if (profile.brightness && patch.brightness !== undefined) {
            dps[profile.brightness.dp] = brightnessToTuya(patch.brightness, profile.brightness.min, profile.brightness.max);
        }
        return dps;
    }

    if (patch.brightness !== undefined) {
        const colourOnly = !profile.brightness; // no white channel: the brightness is that of the colour
        if (profile.color && (current.mode === 'colour' || colourOnly)) {
            dps[profile.color.dp] = formatColor(profile.color, {
                h: current.hue ?? 0,
                s: current.saturation ?? (colourOnly ? 0 : 100),
                v: patch.brightness,
            });
            if (colourOnly && current.mode !== 'colour' && profile.mode !== undefined) {
                dps[profile.mode] = 'colour';
            }
        } else if (profile.brightness) {
            dps[profile.brightness.dp] = brightnessToTuya(patch.brightness, profile.brightness.min, profile.brightness.max);
        }
    }
    return dps;
}
