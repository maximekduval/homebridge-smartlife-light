import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    SharingApi, SharingError, SharingLogin, SharingSession, decryptPayload, deriveSecret, encryptPayload, fetchDevices, md5Hex,
    parseDpRelations, qrContent, randomNonce, signRequest,
} from '../src/cloud/sharing';

// Reference values computed with the code of tuya-device-sharing-sdk (test/fixtures/generate.py).
const v = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'frames.json'), 'utf8')).sharing;

describe('sharing API cryptography', () => {
    const headers = {
        'X-appKey': v.clientId, 'X-requestId': v.rid, 'X-sid': '', 'X-time': String(v.nowMs), 'X-token': v.accessToken,
    };

    it('derives the same keys as the SDK', () => {
        expect(md5Hex(v.rid + v.refreshToken)).toBe(v.hashKey);
        expect(deriveSecret(v.rid, v.hashKey)).toBe(v.secret);
    });

    it('encrypts query and body the same way as the SDK', () => {
        expect(encryptPayload('{"homeId":"12345"}', v.secret, 'ABCDEFGHJKMN')).toBe(v.queryEncdata);
        expect(encryptPayload('{"commands":[{"code":"switch_led","value":true}]}', v.secret, 'nopqrstwxyz2')).toBe(v.bodyEncdata);
    });

    it('signs requests the same way as the SDK', () => {
        expect(signRequest(v.hashKey, v.queryEncdata, '', headers)).toBe(v.signQuery);
        expect(signRequest(v.hashKey, '', v.bodyEncdata, headers)).toBe(v.signBody);
        expect(signRequest(v.hashKey, v.queryEncdata, '', { ...headers, 'X-token': undefined })).toBe(v.signNoToken);
    });

    it('decrypts a server reply', () => {
        expect(decryptPayload(v.reply, v.secret)).toBe(v.replyPlain);
    });

    it('rejects a reply that was tampered with', () => {
        const raw = Buffer.from(v.reply, 'base64');
        raw[14] ^= 1;
        expect(() => decryptPayload(raw.toString('base64'), v.secret)).toThrow();
    });

    it('generates 12-character nonces from the expected alphabet', () => {
        for (let i = 0; i < 50; i++) {
            expect(randomNonce()).toMatch(/^[ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678]{12}$/);
        }
    });
});

/** A tiny stand-in for Tuya's server: checks the signature, decrypts the query, answers encrypted. */
function fakeServer(session: SharingSession, routes: Record<string, (params: any) => unknown>) {
    const calls: { path: string; params: any }[] = [];
    const doFetch = async (url: string, init: any) => {
        const u = new URL(url);
        const h = init.headers;
        const hashKey = md5Hex(h['X-requestId'] + session.refreshToken);
        const secret = deriveSecret(h['X-requestId'], hashKey);

        const queryEnc = u.searchParams.get('encdata') ?? '';
        const bodyEnc = init.body ? JSON.parse(init.body).encdata : '';
        const expected = signRequest(hashKey, queryEnc, bodyEnc, h);
        if (h['X-sign'] !== expected || h['X-token'] !== session.accessToken) {
            return { ok: true, status: 200, json: async () => ({ success: false, code: 1004, msg: 'sign invalid' }) };
        }
        const params = queryEnc ? JSON.parse(decryptViaClientFormat(queryEnc, secret)) : bodyEnc ? JSON.parse(decryptViaClientFormat(bodyEnc, secret)) : {};
        calls.push({ path: u.pathname, params });

        const handler = routes[u.pathname];
        if (!handler) {
            return { ok: true, status: 200, json: async () => ({ success: false, code: 404, msg: 'no such api' }) };
        }
        const nonce = Buffer.from('abcdefhijkmn');
        const crypto = await import('crypto');
        const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(secret), nonce);
        const sealed = Buffer.concat([cipher.update(JSON.stringify(handler(params))), cipher.final(), cipher.getAuthTag()]);
        const result = Buffer.concat([nonce, sealed]).toString('base64');
        return { ok: true, status: 200, json: async () => ({ success: true, result, t: Date.now() }) };
    };
    return { doFetch, calls };
}

// Requests carry base64(nonce) + base64(ciphertext+tag); the first 12 bytes of the nonce encode to exactly 16 characters.
function decryptViaClientFormat(encoded: string, secret: string): string {
    const nonce = Buffer.from(encoded.slice(0, 16), 'base64');
    const sealed = Buffer.from(encoded.slice(16), 'base64');
    return decryptPayload(Buffer.concat([nonce, sealed]).toString('base64'), secret);
}

const session: SharingSession = {
    endpoint: 'https://openapi.example.test',
    accessToken: 'accesstoken0123456789abcdef01',
    refreshToken: 'refreshtoken0123456789abcdef',
    uid: 'eu123',
    terminalId: 'term-1',
    expiresAt: Date.now() + 3600_000,
};

describe('SharingApi', () => {
    it('sends signed, encrypted requests the server accepts, and decrypts the answer', async () => {
        const server = fakeServer(session, { '/v1.0/m/life/users/homes': () => [{ ownerId: 42, name: 'Home' }] });
        const api = new SharingApi(session, server.doFetch as any);
        expect(await api.get('/v1.0/m/life/users/homes')).toEqual([{ ownerId: 42, name: 'Home' }]);
    });

    it('encrypts query parameters', async () => {
        const server = fakeServer(session, { '/x': (p) => ({ echo: p }) });
        const api = new SharingApi(session, server.doFetch as any);
        expect(await api.get('/x', { homeId: '42' })).toEqual({ echo: { homeId: '42' } });
        expect(server.calls[0].params).toEqual({ homeId: '42' });
    });

    it('reports an error from the server', async () => {
        const server = fakeServer({ ...session, accessToken: 'other' }, {});
        const api = new SharingApi(session, server.doFetch as any);
        await expect(api.get('/x')).rejects.toThrow(/sign invalid/);
    });

    it('refuses to use an expired session', async () => {
        const api = new SharingApi({ ...session, expiresAt: Date.now() - 1 }, (async () => { throw new Error('must not be called'); }) as any);
        await expect(api.get('/x')).rejects.toBeInstanceOf(SharingError);
    });

    it('collects lights with their data point codes and ranges', async () => {
        const server = fakeServer(session, {
            '/v1.0/m/life/users/homes': () => [{ ownerId: 42, name: 'Home' }],
            '/v1.0/m/life/ha/home/devices': () => [
                { id: 'light1', name: 'Desk', local_key: 'k'.repeat(16), category: 'dj', product_id: 'p1', product_name: 'Bulb', online: true },
                { id: 'light1', name: 'duplicate', local_key: 'x', category: 'dj' },
            ],
            '/v1.0/m/life/devices/light1/status': () => ({
                productKey: 'p1',
                dpStatusRelationDTOS: [
                    { dpId: 20, statusCode: 'switch_led', valueType: 'Boolean', valueDesc: '{}' },
                    { dpId: 22, statusCode: 'bright_value_v2', valueType: 'Integer', valueDesc: '{"min":10,"max":1000,"scale":0,"step":1}' },
                ],
            }),
        });
        const devices = await fetchDevices(new SharingApi(session, server.doFetch as any));
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ id: 'light1', name: 'Desk', localKey: 'kkkkkkkkkkkkkkkk', category: 'dj', online: true });
        expect(devices[0].dps).toEqual([
            { id: 20, code: 'switch_led', type: 'Boolean' },
            { id: 22, code: 'bright_value_v2', type: 'Integer', min: 10, max: 1000 },
        ]);
    });

    it('survives a device whose data points cannot be read', async () => {
        const server = fakeServer(session, {
            '/v1.0/m/life/users/homes': () => [{ ownerId: 1, name: 'H' }],
            '/v1.0/m/life/ha/home/devices': () => [{ id: 'a', name: 'A', local_key: 'k'.repeat(16) }],
        });
        const devices = await fetchDevices(new SharingApi(session, server.doFetch as any));
        expect(devices[0].dps).toEqual([]);
    });
});

describe('parseDpRelations', () => {
    it('ignores malformed entries', () => {
        expect(parseDpRelations({ dpStatusRelationDTOS: [{ dpId: 'x', statusCode: 'a' }, { dpId: 1 }, null] })).toEqual([]);
        expect(parseDpRelations(undefined)).toEqual([]);
    });
});

describe('SharingLogin', () => {
    it('requests a QR code and shows the content the app expects', async () => {
        let requested = '';
        const login = new SharingLogin((async (url: string, init: any) => {
            requested = `${init.method} ${url}`;
            return { ok: true, status: 200, json: async () => ({ success: true, result: { qrcode: 'abc123' } }) };
        }) as any);
        const token = await login.requestQrCode('EU123456');
        expect(token).toBe('abc123');
        expect(requested).toContain('POST https://apigw.iotbing.com/v1.0/m/life/home-assistant/qrcode/tokens?clientid=HA_3y9q4ak7g4ephrvke&usercode=EU123456&schema=haauthorize');
        expect(qrContent(token)).toBe('tuyaSmart--qrLogin?token=abc123');
        expect(qrContent(token, 'smartlife')).toBe('smartlife--qrLogin?token=abc123');
    });

    it('turns a refused user code into a readable error', async () => {
        const login = new SharingLogin((async () => ({ ok: true, status: 200, json: async () => ({ success: false, code: 2017, msg: 'user code invalid' }) })) as any);
        await expect(login.requestQrCode('nope')).rejects.toThrow(/user code invalid/);
    });

    it('keeps waiting until the QR code is scanned, then returns the session', async () => {
        const answers: any[] = [
            { success: false, code: 1000, msg: 'waiting' },
            { success: true, t: 1700000000000, result: {
                endpoint: 'https://openapi.tuyaeu.com', access_token: 'at', refresh_token: 'rt', uid: 'u', terminal_id: 'tid', expire_time: 7200,
            } },
        ];
        const login = new SharingLogin((async () => ({ ok: true, status: 200, json: async () => answers.shift() })) as any);
        expect(await login.pollLogin('abc', 'EU1')).toBeNull();
        expect(await login.pollLogin('abc', 'EU1')).toEqual({
            endpoint: 'https://openapi.tuyaeu.com', accessToken: 'at', refreshToken: 'rt', uid: 'u', terminalId: 'tid',
            expiresAt: 1700000000000 + 7200 * 1000,
        });
    });
});
