import { afterEach, describe, expect, it } from 'vitest';
import { TuyaDevice, TuyaDeviceOptions } from '../src/tuya/device';
import { Dps, ProtocolVersion } from '../src/tuya/protocol';
import { FakeTuyaDevice } from './helpers/fakeDevice';

const ID = 'bf0123456789abcdef0123';
const KEY = '0123456789abcdef';
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const fakes: FakeTuyaDevice[] = [];
const clients: TuyaDevice[] = [];

async function setup(version: ProtocolVersion, dps: Dps = { 20: false, 22: 500 }) {
    const fake = new FakeTuyaDevice(ID, KEY, version, dps);
    await fake.listen();
    fakes.push(fake);
    return fake;
}

function client(fake: FakeTuyaDevice, extra: Partial<TuyaDeviceOptions> = {}) {
    const device = new TuyaDevice({
        id: ID, key: KEY, ip: '127.0.0.1', port: fake.port, log: silent,
        requestTimeoutMs: 250, connectTimeoutMs: 500, heartbeatMs: 60, reconnectBaseMs: 20, reconnectMaxMs: 60,
        ...extra,
    });
    clients.push(device);
    return device;
}

const once = <T>(device: TuyaDevice, event: 'connected' | 'disconnected' | 'dps' | 'connect-failed') =>
    new Promise<T>((resolve) => device.once(event as any, (...args: any[]) => resolve(args as any)));

afterEach(async () => {
    for (const c of clients.splice(0)) {
        c.stop();
    }
    for (const f of fakes.splice(0)) {
        await f.close();
    }
});

describe.each<ProtocolVersion>(['3.3', '3.4', '3.5'])('TuyaDevice over protocol %s', (version) => {
    it('connects and reads the current state', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;
        expect(device.isReady).toBe(true);
        expect(device.dps).toEqual({ 20: false, 22: 500 });
    });

    it('detects the protocol version on its own', async () => {
        const fake = await setup(version);
        const device = client(fake);
        const connected = once(device, 'connected');
        device.start();
        await connected;
        expect(device.version).toBe(version);
    });

    it('sends changes and gets the acknowledgement', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;

        await device.set({ 20: true, 22: 900 });
        expect(fake.controls).toEqual([{ 20: true, 22: 900 }]);
        expect(device.dps).toMatchObject({ 20: true, 22: 900 });
    });

    it('applies state pushed by the device (wall switch, other app)', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;

        const changed = once<[Dps, Dps]>(device, 'dps');
        fake.push({ 20: true });
        const [delta, all] = await changed;
        expect(delta).toEqual({ 20: true });
        expect(all).toMatchObject({ 20: true, 22: 500 });
    });

    it('sends heartbeats to keep the link alive', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;
        await new Promise((r) => setTimeout(r, 250));
        expect(fake.heartbeats).toBeGreaterThanOrEqual(2);
        expect(device.isReady).toBe(true);
    });

    it('reconnects by itself when the connection drops', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;

        const lost = once(device, 'disconnected');
        const back = once(device, 'connected');
        fake.dropConnections();
        await lost;
        await back;
        expect(device.isReady).toBe(true);
        await device.set({ 20: true });
        expect(fake.controls.at(-1)).toEqual({ 20: true });
    });

    it('treats a missing acknowledgement as a failure', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;

        fake.ack = false;
        fake.pushOnControl = false;
        await expect(device.set({ 20: true })).rejects.toThrow(/no answer/);
    });

    it('detects a frozen device through the heartbeat and reconnects', async () => {
        const fake = await setup(version);
        const device = client(fake, { version });
        const connected = once(device, 'connected');
        device.start();
        await connected;

        const lost = once(device, 'disconnected');
        fake.mute = true;
        await lost;
        const back = once(device, 'connected');
        fake.mute = false;
        await back;
        expect(device.isReady).toBe(true);
    });
});

describe('TuyaDevice failures', () => {
    it('never connects with a wrong local key and reports why', async () => {
        const fake = await setup('3.4');
        const device = client(fake, { key: 'ffffffffffffffff' });
        const failed = once<[Error, number]>(device, 'connect-failed');
        device.start();
        const [error, count] = await failed;
        expect(count).toBe(1);
        expect(error.message).toMatch(/no answer|wrong/);
        expect(device.isReady).toBe(false);
    });

    it('refuses to set data while disconnected', async () => {
        const fake = await setup('3.3');
        const device = client(fake);
        await expect(device.set({ 20: true })).rejects.toThrow(/not connected/);
    });

    it('reports an unreachable device and keeps retrying', async () => {
        const fake = await setup('3.3');
        const port = fake.port;
        await fake.close();
        fakes.pop();

        const device = new TuyaDevice({
            id: ID, key: KEY, ip: '127.0.0.1', port, log: silent, connectTimeoutMs: 200, reconnectBaseMs: 10, reconnectMaxMs: 20,
        });
        clients.push(device);
        let attempts = 0;
        const third = new Promise<void>((resolve) => device.on('connect-failed', () => {
            if (++attempts === 3) {
                resolve();
            }
        }));
        device.start();
        await third;
        expect(device.isReady).toBe(false);
    });

    it('rejects a local key that is not 16 characters', () => {
        expect(() => new TuyaDevice({ id: ID, key: 'short', ip: '127.0.0.1', log: silent })).toThrow(/16 characters/);
    });
});
