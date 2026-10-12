/**
 * The file where setup keeps what it learned from the cloud: device ids, names and local keys.
 * It lives in Homebridge's storage folder and is readable by its owner only, since local keys control the lights.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DpInfo } from './tuya/light';
import { ProtocolVersion } from './tuya/protocol';

export const STORE_FILE = 'smartlife-light.json';

/** Used when Homebridge runs on another machine: setup saves here, and the file is copied over. */
export const LOCAL_FOLDER = '.smartlife-light';

export interface StoredDevice {
    id: string;
    name: string;
    localKey: string;
    category?: string;
    productId?: string;
    productName?: string;
    /** Data points with their codes and ranges, as reported by the cloud. */
    dps?: DpInfo[];
    /** Last IP address and protocol version seen: only hints, they are re-discovered when they stop working. */
    ip?: string;
    version?: ProtocolVersion;
}

export interface StoreData {
    version: 1;
    devices: StoredDevice[];
}

/** Where Homebridge keeps its files, when the user did not tell us. */
export function findStoragePath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
    const candidates = [
        env.UIX_STORAGE_PATH,
        env.HOMEBRIDGE_STORAGE_PATH,
        path.join(home, '.homebridge'),
        '/var/lib/homebridge',
        path.join(home, LOCAL_FOLDER),
    ].filter((p): p is string => Boolean(p));
    return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()) ?? null;
}

export class DeviceStore {
    constructor(readonly dir: string) {}

    get file(): string {
        return path.join(this.dir, STORE_FILE);
    }

    read(): StoreData {
        if (!fs.existsSync(this.file)) {
            return { version: 1, devices: [] };
        }
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!Array.isArray(data?.devices)) {
                throw new Error('no device list');
            }
            return { version: 1, devices: data.devices };
        } catch (e) {
            throw new Error(`${this.file} is not readable (${(e as Error).message}). Delete it and run the setup again.`);
        }
    }

    write(data: StoreData) {
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        // run with sudo, the file must still belong to the user Homebridge runs as, or the plugin could not read it
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            const owner = fs.statSync(this.dir);
            fs.chownSync(tmp, owner.uid, owner.gid);
        }
        fs.renameSync(tmp, this.file);
    }

    /** Adds or refreshes devices from the cloud, keeping what we learned locally (IP, protocol version). */
    upsert(devices: StoredDevice[]): StoreData {
        const data = this.read();
        for (const incoming of devices) {
            const index = data.devices.findIndex((d) => d.id === incoming.id);
            if (index < 0) {
                data.devices.push(incoming);
                continue;
            }
            const existing = data.devices[index];
            const sameKey = existing.localKey === incoming.localKey;
            data.devices[index] = {
                ...incoming,
                ip: existing.ip,
                // a new key means the light was paired again, possibly on newer firmware: detect the version again
                version: sameKey ? existing.version : undefined,
            };
        }
        this.write(data);
        return data;
    }

    /** Remembers what we learned about one device (its IP address, its protocol version). */
    patch(id: string, changes: Partial<StoredDevice>) {
        const data = this.read();
        const device = data.devices.find((d) => d.id === id);
        if (!device) {
            return;
        }
        const next = { ...device, ...changes };
        if (JSON.stringify(next) !== JSON.stringify(device)) {
            Object.assign(device, changes);
            this.write(data);
        }
    }
}
