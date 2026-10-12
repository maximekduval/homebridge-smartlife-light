/**
 * Talks to Tuya's "device sharing" cloud API, the one third-party apps use to let a Smart Life user sign in by scanning
 * a QR code. It is used once, during setup, to read the local key of each device: after that the light is controlled
 * entirely over the local network.
 *
 * Ported from tuya-device-sharing-sdk (MIT, https://github.com/tuya/tuya-device-sharing-sdk), checked against vectors
 * produced by that code (test/fixtures/generate.py).
 *
 * The client id below is the one registered for Home Assistant's official Tuya integration. Tuya does not offer a way
 * to register one for a plugin like this without a developer agreement, so this may stop working one day.
 */
import * as crypto from 'crypto';
import { DpInfo } from '../tuya/light';

export const CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
export const SCHEMA = 'haauthorize';
export const LOGIN_HOST = 'https://apigw.iotbing.com';

export type QrScheme = 'tuyaSmart' | 'smartlife';

export class SharingError extends Error {
    constructor(message: string, public readonly code?: string | number) {
        super(message);
    }
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

// ---------------------------------------------------------------------------------------------
// Request signing and encryption
// ---------------------------------------------------------------------------------------------

const NONCE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

export function md5Hex(text: string): string {
    return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** Per-request AES key: the first 16 hex digits of HMAC-SHA256(key = request id, message = hashKey). */
export function deriveSecret(requestId: string, hashKey: string): string {
    return crypto.createHmac('sha256', requestId).update(hashKey).digest('hex').slice(0, 16);
}

export function randomNonce(length = 12): string {
    const bytes = crypto.randomBytes(length);
    let nonce = '';
    for (let i = 0; i < length; i++) {
        nonce += NONCE_ALPHABET[bytes[i] % NONCE_ALPHABET.length];
    }
    return nonce;
}

/** Output is base64(nonce) followed by base64(ciphertext + tag), as one string. */
export function encryptPayload(plain: string, secret: string, nonce = randomNonce()): string {
    const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), Buffer.from(nonce, 'utf8'));
    const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return Buffer.from(nonce, 'utf8').toString('base64') + sealed.toString('base64');
}

/** The server answers with base64(nonce || ciphertext || tag). */
export function decryptPayload(encoded: string, secret: string): string {
    const raw = Buffer.from(encoded, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

export function signRequest(
    hashKey: string, queryEnc: string, bodyEnc: string, headers: Record<string, string | undefined>,
): string {
    let toSign = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
        .filter((name) => headers[name])
        .map((name) => `${name}=${headers[name]}`)
        .join('||');
    toSign += queryEnc + bodyEnc;
    return crypto.createHmac('sha256', hashKey).update(toSign, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------------------------

export interface SharingSession {
    endpoint: string;
    accessToken: string;
    refreshToken: string;
    uid: string;
    terminalId: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

export function qrContent(token: string, scheme: QrScheme = 'tuyaSmart'): string {
    return `${scheme}--qrLogin?token=${token}`;
}

export class SharingLogin {
    constructor(private readonly doFetch: FetchLike = fetch as unknown as FetchLike, private readonly host = LOGIN_HOST) {}

    /** Asks for a QR code. The user must scan `qrContent(token)` with the Smart Life app. */
    async requestQrCode(userCode: string): Promise<string> {
        const url = `${this.host}/v1.0/m/life/home-assistant/qrcode/tokens`
            + `?clientid=${encodeURIComponent(CLIENT_ID)}&usercode=${encodeURIComponent(userCode)}&schema=${SCHEMA}`;
        const res = await this.doFetch(url, { method: 'POST' });
        const json = await res.json();
        if (!json?.success) {
            throw new SharingError(json?.msg ?? `Tuya refused the request (HTTP ${res.status})`, json?.code);
        }
        return json.result.qrcode;
    }

    /** Returns the session once the QR code has been scanned and approved, null while we are still waiting. */
    async pollLogin(token: string, userCode: string): Promise<SharingSession | null> {
        const url = `${this.host}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}`
            + `?clientid=${encodeURIComponent(CLIENT_ID)}&usercode=${encodeURIComponent(userCode)}`;
        const res = await this.doFetch(url, { method: 'GET' });
        const json = await res.json();
        if (!json?.success) {
            return null;
        }
        const r = json.result ?? {};
        return {
            endpoint: r.endpoint,
            accessToken: r.access_token,
            refreshToken: r.refresh_token,
            uid: r.uid,
            terminalId: r.terminal_id,
            expiresAt: Number(json.t ?? Date.now()) + Number(r.expire_time ?? 0) * 1000,
        };
    }
}

// ---------------------------------------------------------------------------------------------
// Authenticated API
// ---------------------------------------------------------------------------------------------

export class SharingApi {
    constructor(private readonly session: SharingSession, private readonly doFetch: FetchLike = fetch as unknown as FetchLike) {}

    async request(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, body?: Record<string, unknown>) {
        if (Date.now() > this.session.expiresAt - 30_000) {
            throw new SharingError('The Smart Life session expired, run the setup again');
        }
        const requestId = crypto.randomUUID();
        const hashKey = md5Hex(requestId + this.session.refreshToken);
        const secret = deriveSecret(requestId, hashKey);

        let queryEnc = '';
        let bodyEnc = '';
        if (params && Object.keys(params).length > 0) {
            queryEnc = encryptPayload(JSON.stringify(params), secret);
        }
        if (body && Object.keys(body).length > 0) {
            bodyEnc = encryptPayload(JSON.stringify(body), secret);
        }

        const headers: Record<string, string> = {
            'X-appKey': CLIENT_ID,
            'X-requestId': requestId,
            'X-sid': '',
            'X-time': String(Date.now()),
        };
        if (this.session.accessToken) {
            headers['X-token'] = this.session.accessToken;
        }
        headers['X-sign'] = signRequest(hashKey, queryEnc, bodyEnc, headers);

        const query = queryEnc ? `?${new URLSearchParams({ encdata: queryEnc }).toString()}` : '';
        const init: any = { method, headers: { ...headers } };
        if (bodyEnc) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify({ encdata: bodyEnc });
        }
        const res = await this.doFetch(`${this.session.endpoint}${path}${query}`, init);
        if (!res.ok) {
            throw new SharingError(`Tuya answered HTTP ${res.status} for ${path}`);
        }
        const json = await res.json();
        if (!json?.success) {
            throw new SharingError(json?.msg ?? `Tuya refused ${path}`, json?.code);
        }
        if (typeof json.result === 'string') {
            const plain = decryptPayload(json.result, secret);
            try {
                return JSON.parse(plain);
            } catch {
                return plain;
            }
        }
        return json.result;
    }

    get(path: string, params?: Record<string, unknown>) {
        return this.request('GET', path, params);
    }

    post(path: string, body: Record<string, unknown>) {
        return this.request('POST', path, undefined, body);
    }

    /** Invalidates this session on Tuya's side. Best effort. */
    async logout() {
        try {
            await this.post('/v1.0/m/token/terminal/expire', {
                accessToken: this.session.accessToken,
                terminalId: this.session.terminalId,
            });
        } catch {
            // the token expires by itself anyway
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

export interface CloudDevice {
    id: string;
    name: string;
    localKey: string;
    category: string;
    productId: string;
    productName: string;
    uuid: string;
    online: boolean;
    /** Data points of the device with their codes and ranges. */
    dps: DpInfo[];
}

function parseDesc(desc: unknown): { min?: number; max?: number } {
    if (typeof desc !== 'string' || !desc.trim().startsWith('{')) {
        return {};
    }
    try {
        const o = JSON.parse(desc);
        return {
            min: typeof o.min === 'number' ? o.min : undefined,
            max: typeof o.max === 'number' ? o.max : undefined,
        };
    } catch {
        return {};
    }
}

/** Reads `dpStatusRelationDTOS` of `/v1.0/m/life/devices/{id}/status`, which maps each DP number to its code. */
export function parseDpRelations(result: any): DpInfo[] {
    const relations: any[] = Array.isArray(result?.dpStatusRelationDTOS) ? result.dpStatusRelationDTOS : [];
    return relations
        .filter((r) => Number.isInteger(r?.dpId) && typeof r?.statusCode === 'string')
        .map((r) => ({ id: r.dpId, code: r.statusCode, type: r.valueType, ...parseDesc(r.valueDesc) }));
}

export async function fetchDevices(api: SharingApi, onProgress: (message: string) => void = () => undefined): Promise<CloudDevice[]> {
    const homes: any[] = (await api.get('/v1.0/m/life/users/homes')) ?? [];
    const devices: CloudDevice[] = [];
    const seen = new Set<string>();

    for (const home of homes) {
        onProgress(`Reading home "${home.name}"`);
        const list: any[] = (await api.get('/v1.0/m/life/ha/home/devices', { homeId: String(home.ownerId) })) ?? [];
        for (const item of list) {
            if (!item?.id || seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            let dps: DpInfo[] = [];
            try {
                dps = parseDpRelations(await api.get(`/v1.0/m/life/devices/${item.id}/status`));
            } catch {
                // not fatal: the light will be profiled from its own status instead
            }
            devices.push({
                id: item.id,
                name: item.name ?? item.id,
                localKey: item.local_key ?? '',
                category: item.category ?? '',
                productId: item.product_id ?? '',
                productName: item.product_name ?? '',
                uuid: item.uuid ?? '',
                online: Boolean(item.online),
                dps,
            });
        }
    }
    return devices;
}
