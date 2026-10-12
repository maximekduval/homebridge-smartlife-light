import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceStore, STORE_FILE, StoredDevice, findStoragePath } from '../src/store';

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartlife-store-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const light = (extra: Partial<StoredDevice> = {}): StoredDevice => ({ id: 'a1', name: 'Desk', localKey: '0123456789abcdef', ...extra });

describe('DeviceStore', () => {
    it('starts empty', () => {
        expect(new DeviceStore(dir).read()).toEqual({ version: 1, devices: [] });
    });

    it('writes a file only its owner can read', () => {
        const store = new DeviceStore(dir);
        store.upsert([light()]);
        expect(fs.statSync(path.join(dir, STORE_FILE)).mode & 0o777).toBe(0o600);
        expect(new DeviceStore(dir).read().devices).toEqual([light()]);
    });

    it('keeps the IP and protocol version learned locally when the cloud data is refreshed', () => {
        const store = new DeviceStore(dir);
        store.upsert([light()]);
        store.patch('a1', { ip: '192.168.1.50', version: '3.3' });
        store.upsert([light({ name: 'Renamed' })]);
        expect(store.read().devices[0]).toMatchObject({ name: 'Renamed', ip: '192.168.1.50', version: '3.3' });
    });

    it('forgets the protocol version when the light was paired again with a new key', () => {
        const store = new DeviceStore(dir);
        store.upsert([light()]);
        store.patch('a1', { ip: '192.168.1.50', version: '3.3' });
        store.upsert([light({ localKey: 'fedcba9876543210' })]);
        const device = store.read().devices[0];
        expect(device.version).toBeUndefined();
        expect(device.ip).toBe('192.168.1.50');
    });

    it('does not rewrite the file when nothing changed', () => {
        const store = new DeviceStore(dir);
        store.upsert([light()]);
        const before = fs.statSync(store.file).mtimeMs;
        store.patch('a1', {});
        expect(fs.statSync(store.file).mtimeMs).toBe(before);
    });

    it('ignores a patch for an unknown device', () => {
        const store = new DeviceStore(dir);
        store.patch('ghost', { ip: '1.2.3.4' });
        expect(fs.existsSync(store.file)).toBe(false);
    });

    it('explains how to recover from a corrupt file', () => {
        fs.writeFileSync(path.join(dir, STORE_FILE), '{not json');
        expect(() => new DeviceStore(dir).read()).toThrow(/Delete it and run the setup again/);
    });
});

describe('findStoragePath', () => {
    it('prefers the folder Homebridge UI announces', () => {
        expect(findStoragePath({ UIX_STORAGE_PATH: dir }, '/nonexistent')).toBe(dir);
    });

    it('falls back to ~/.homebridge', () => {
        fs.mkdirSync(path.join(dir, '.homebridge'));
        expect(findStoragePath({}, dir)).toBe(path.join(dir, '.homebridge'));
    });

    it('uses the local folder when Homebridge runs on another machine', () => {
        fs.mkdirSync(path.join(dir, '.smartlife-light'));
        expect(findStoragePath({}, dir)).toBe(path.join(dir, '.smartlife-light'));
    });

    it('returns null when Homebridge cannot be found', () => {
        expect(findStoragePath({}, path.join(dir, 'nothing'))).toBeNull();
    });
});
