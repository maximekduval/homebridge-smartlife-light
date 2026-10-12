/**
 * Merges what the setup stored (cloud data) with what the user wrote in config.json.
 *
 * The Homebridge config is optional: `{ "platform": "SmartLifeLight" }` is enough once the setup ran. A `devices` list
 * lets the user rename a light, pin its IP address, or declare a light by hand (id + local key) without any cloud.
 */
import { ExtraOverride, ExtraSpec, findPreset, resolveExtras } from './extras';
import { StoredDevice } from './store';
import { DpInfo } from './tuya/light';
import { PROTOCOL_VERSIONS, ProtocolVersion } from './tuya/protocol';

export interface DeviceOverride {
    id: string;
    name?: string;
    /** Local key, only needed for a light that is not in the setup file. */
    key?: string;
    ip?: string;
    /** TCP port of the light, 6668 on every real Tuya light. */
    port?: number;
    version?: ProtocolVersion | string;
    /** Warmest and coolest white of the lamp, in kelvin. */
    minKelvin?: number;
    maxKelvin?: number;
    /** Extra controls (switches, sliders) on top of the light: renames/hides preset ones, or adds new ones. */
    extras?: ExtraOverride[];
    exclude?: boolean;
}

export interface ResolvedLight {
    id: string;
    name: string;
    key: string;
    ip?: string;
    port?: number;
    version?: ProtocolVersion;
    /** The user fixed the version: never try another one. */
    lockVersion: boolean;
    category?: string;
    productId?: string;
    productName?: string;
    dps?: DpInfo[];
    /** False when the main Brightness is the brightness of the colour (see `Preset`). */
    whiteBrightness: boolean;
    extras: ExtraSpec[];
    minKelvin: number;
    maxKelvin: number;
}

/** Tuya product categories of lights: light, strip light, ceiling light, ambiance, string lights, dimmer. */
const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'xdd', 'fwd', 'dc', 'tgq', 'tyndj']);
const SWITCH_CODES = new Set(['switch_led', 'switch_led_1']);

export function isLight(device: Pick<StoredDevice, 'category' | 'dps'>): boolean {
    if (device.dps && device.dps.length > 0 && device.dps.some((d) => SWITCH_CODES.has(d.code))) {
        return true;
    }
    if (device.category) {
        return LIGHT_CATEGORIES.has(device.category);
    }
    return !device.dps || device.dps.length === 0; // declared by hand: trust the user
}

function asVersion(value: unknown): ProtocolVersion | undefined {
    const text = typeof value === 'number' ? value.toFixed(1) : String(value ?? '');
    return PROTOCOL_VERSIONS.includes(text as ProtocolVersion) ? (text as ProtocolVersion) : undefined;
}

export interface Resolution {
    lights: ResolvedLight[];
    skipped: string[];
    problems: string[];
}

export function resolveLights(stored: StoredDevice[], overrides: DeviceOverride[] = []): Resolution {
    const lights: ResolvedLight[] = [];
    const skipped: string[] = [];
    const problems: string[] = [];
    const byId = new Map(overrides.filter((o) => o?.id).map((o) => [o.id, o]));
    const ids = new Set<string>([...stored.map((d) => d.id), ...byId.keys()]);

    for (const id of ids) {
        const base = stored.find((d) => d.id === id);
        const override = byId.get(id);
        if (override?.exclude) {
            skipped.push(`${base?.name ?? id} (excluded in the configuration)`);
            continue;
        }
        const key = override?.key ?? base?.localKey;
        if (!key) {
            problems.push(`"${override?.name ?? id}" has no local key: run the setup, or add "key" to its entry in the configuration.`);
            continue;
        }
        if (key.length !== 16) {
            problems.push(`The local key of "${override?.name ?? base?.name ?? id}" must be 16 characters long (it has ${key.length}).`);
            continue;
        }
        if (base && !isLight(base)) {
            skipped.push(`${base.name} (not a light)`);
            continue;
        }
        const configuredVersion = asVersion(override?.version);
        if (override?.version !== undefined && override.version !== '' && !configuredVersion) {
            problems.push(`"version" of "${override?.name ?? id}" must be one of ${PROTOCOL_VERSIONS.join(', ')}; `
                + 'it will be detected instead.');
        }
        const preset = findPreset(base?.productId);
        const resolvedExtras = resolveExtras(preset, override?.extras, base?.dps);
        for (const problem of resolvedExtras.problems) {
            problems.push(`${override?.name ?? base?.name ?? id}: ${problem}`);
        }
        lights.push({
            id,
            name: override?.name ?? base?.name ?? `Light ${id.slice(-4)}`,
            key,
            ip: override?.ip ?? base?.ip,
            port: override?.port,
            version: configuredVersion ?? base?.version,
            lockVersion: Boolean(configuredVersion),
            category: base?.category,
            productId: base?.productId,
            productName: base?.productName,
            dps: base?.dps,
            whiteBrightness: preset?.whiteBrightness ?? true,
            extras: resolvedExtras.extras,
            minKelvin: override?.minKelvin ?? 2700,
            maxKelvin: override?.maxKelvin ?? 6500,
        });
    }
    return { lights, skipped, problems };
}
