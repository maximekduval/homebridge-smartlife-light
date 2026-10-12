/**
 * Extra controls: features of a lamp that are not plain light bulb features, exposed as additional HomeKit tiles
 * on the same accessory (a star projector has a star switch, a star intensity, a rotation speed...).
 *
 * Each extra is tied to a Tuya data point (`all` is a master switch: it is tied to the main power and drives the others).
 * They come from two places:
 *  - a preset, for products we know (matched on the Tuya product id), so that nothing has to be configured;
 *  - the `extras` list of a light in the configuration, which can rename or hide preset extras and add new ones.
 *    `smartlife-light watch <light>` shows which data point does what.
 */
import { DpInfo } from './tuya/light';

export type ExtraType = 'switch' | 'light' | 'fan' | 'all';
const TYPES: ExtraType[] = ['switch', 'light', 'fan', 'all'];

export interface ExtraOverride {
    dp: number;
    type?: ExtraType | string;
    name?: string;
    /** `light` only: the data point holding the brightness. */
    brightnessDp?: number;
    /** Range of the data point: the brightness of a `light`, the speed of a `fan`. */
    min?: number;
    max?: number;
    /** Turning it on also switches the lamp's main power on. */
    powerOn?: boolean;
    /**
     * `light` only: a fixed colour (hue 0-360, saturation 0-100) the Home app tints the tile and the slider with,
     * for a light that is always one colour (green stars). It cannot be changed from HomeKit.
     */
    hue?: number;
    saturation?: number;
    exclude?: boolean;
}

export interface ExtraSpec {
    type: ExtraType;
    name: string;
    /** On/off for `switch` and `light`, speed for `fan`, the main power for `all`. */
    dp: number;
    brightnessDp?: number;
    min: number;
    max: number;
    powerOn: boolean;
    hue?: number;
    saturation?: number;
}

export interface Preset {
    name: string;
    /**
     * The lamp has no separate white brightness: its main Brightness is the brightness of the colour.
     * (On a star projector the "white" brightness is the intensity of the stars, which is an extra.)
     */
    whiteBrightness: boolean;
    extras: ExtraOverride[];
}

/** Smart Star Projector / "Nebula Glow": nebula light (colour), stars, and a rotation of both. */
const STAR_PROJECTOR: Preset = {
    name: 'Smart Star Projector',
    whiteBrightness: false,
    extras: [
        // the Home app opens a list instead of toggling when a lamp has several tiles: a master switch is needed there
        { dp: 20, type: 'all', name: 'All' },
        { dp: 102, type: 'light', name: 'Stars', brightnessDp: 22, min: 10, max: 1000, powerOn: true, hue: 120, saturation: 100 },
        { dp: 103, type: 'switch', name: 'Nebula', powerOn: true },
        { dp: 101, type: 'fan', name: 'Rotation', min: 0, max: 1000, powerOn: true },
    ],
};

/**
 * Keyed by Tuya product id. The cloud and the lamp itself do not call it the same: the setup saves the cloud's
 * `product_id`, while the lamp announces a `productKey` on the network. Both are listed for the same product.
 */
const PRESETS: Record<string, Preset> = {
    hi3ejekqmmgajyxz: STAR_PROJECTOR, // cloud product_id
    keypaujpukpnpy8s: STAR_PROJECTOR, // productKey announced by the lamp
};

export function findPreset(productId?: string): Preset | undefined {
    return productId ? PRESETS[productId] : undefined;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface ResolvedExtras {
    extras: ExtraSpec[];
    problems: string[];
}

/** Merges the preset with the user's `extras` (matched on `dp`) and checks the result. */
export function resolveExtras(preset: Preset | undefined, overrides: unknown, dps?: DpInfo[]): ResolvedExtras {
    const problems: string[] = [];
    const merged = new Map<number, ExtraOverride>();
    for (const extra of preset?.extras ?? []) {
        merged.set(extra.dp, { ...extra });
    }

    for (const raw of Array.isArray(overrides) ? overrides : []) {
        if (!raw || !Number.isInteger(raw.dp)) {
            problems.push('An entry of "extras" has no valid "dp" (the data point number): ignored.');
            continue;
        }
        // keep only what the user actually filled in, so an empty form field does not erase a preset value
        const given: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
            if (value !== undefined && value !== null && value !== '') {
                given[key] = value;
            }
        }
        merged.set(raw.dp, { ...merged.get(raw.dp), ...given } as ExtraOverride);
    }

    const extras: ExtraSpec[] = [];
    for (const [dp, e] of merged) {
        if (e.exclude) {
            continue;
        }
        if (!TYPES.includes(e.type as ExtraType)) {
            problems.push(`Extra on data point ${dp}: "type" must be one of ${TYPES.join(', ')}; ignored.`);
            continue;
        }
        const type = e.type as ExtraType;
        if (type === 'light' && e.brightnessDp !== undefined && !Number.isInteger(e.brightnessDp)) {
            problems.push(`Extra "${e.name ?? dp}": "brightnessDp" must be a data point number; the brightness is ignored.`);
        }
        const rangeDp = type === 'light' ? e.brightnessDp : dp;
        const info = dps?.find((d) => d.id === rangeDp);
        let min = isNumber(e.min) ? e.min : (info?.min ?? 0);
        let max = isNumber(e.max) ? e.max : (info?.max ?? 1000);
        if (min >= max) {
            problems.push(`Extra "${e.name ?? dp}": "min" must be lower than "max"; using 0 to 1000.`);
            min = 0;
            max = 1000;
        }
        let hue: number | undefined;
        let saturation: number | undefined;
        if (type === 'light' && e.hue !== undefined) {
            if (isNumber(e.hue) && e.hue >= 0 && e.hue <= 360) {
                hue = e.hue;
                saturation = isNumber(e.saturation) && e.saturation >= 0 && e.saturation <= 100 ? e.saturation : 100;
            } else {
                problems.push(`Extra "${e.name ?? dp}": "hue" must be between 0 and 360; the tile keeps its default colour.`);
            }
        }
        extras.push({
            type,
            dp,
            name: e.name || (type === 'fan' ? `Fan ${dp}` : type === 'all' ? 'All' : `Extra ${dp}`),
            brightnessDp: type === 'light' && Number.isInteger(e.brightnessDp) ? e.brightnessDp : undefined,
            min,
            max,
            powerOn: Boolean(e.powerOn),
            hue,
            saturation,
        });
    }
    return { extras, problems };
}
