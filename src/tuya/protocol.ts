/**
 * Tuya LAN protocol codec (versions 3.3, 3.4 and 3.5).
 *
 * The protocol is not officially documented. This implementation follows the community
 * reverse-engineering work and is checked byte-for-byte against TinyTuya's output
 * (see test/protocol.test.ts and test/fixtures/generate.py).
 *
 * Two frame formats exist on the wire:
 *
 *  55AA (3.3, 3.4)   prefix(4) seq(4) cmd(4) length(4) | [retcode(4)] payload | crc32(4) or hmac-sha256(32) | suffix(4)
 *  6699 (3.5)        prefix(4) 0000(2) seq(4) cmd(4) length(4) | iv(12) ciphertext tag(16) | suffix(4)
 *
 * 3.3 encrypts with AES-128-ECB (key = local key) and uses a CRC32.
 * 3.4 encrypts with AES-128-ECB and signs with HMAC-SHA256, using a per-connection session key.
 * 3.5 encrypts with AES-128-GCM (the 14 header bytes after the prefix are the AAD), also with a session key.
 *
 * Frames sent by the device carry a 4-byte return code in front of the payload
 * (outside the encryption for 55AA, inside it for 6699).
 */
import * as crypto from 'crypto';

export type ProtocolVersion = '3.3' | '3.4' | '3.5';
export const PROTOCOL_VERSIONS: ProtocolVersion[] = ['3.3', '3.4', '3.5'];

export const Cmd = {
    SESS_KEY_NEG_START: 0x03,
    SESS_KEY_NEG_RESP: 0x04,
    SESS_KEY_NEG_FINISH: 0x05,
    CONTROL: 0x07,
    STATUS: 0x08,
    HEART_BEAT: 0x09,
    DP_QUERY: 0x0a,
    CONTROL_NEW: 0x0d,
    DP_QUERY_NEW: 0x10,
    UPDATE_DPS: 0x12,
    UDP_NEW: 0x13,
    REQ_DEVINFO: 0x25,
    LAN_EXT_STREAM: 0x40,
} as const;

export const PREFIX_55AA = 0x000055aa;
export const SUFFIX_55AA = 0x0000aa55;
export const PREFIX_6699 = 0x00006699;
export const SUFFIX_6699 = 0x00009966;

const HEADER_LEN_55AA = 16;
const HEADER_LEN_6699 = 18;
const MAX_PAYLOAD_LENGTH = 0x1000;

/** Commands whose payload is sent without the "3.x" version header. */
const NO_VERSION_HEADER = new Set<number>([
    Cmd.DP_QUERY, Cmd.DP_QUERY_NEW, Cmd.UPDATE_DPS, Cmd.HEART_BEAT,
    Cmd.SESS_KEY_NEG_START, Cmd.SESS_KEY_NEG_RESP, Cmd.SESS_KEY_NEG_FINISH, Cmd.LAN_EXT_STREAM,
]);

const NEGOTIATION_CMDS = new Set<number>([Cmd.SESS_KEY_NEG_START, Cmd.SESS_KEY_NEG_RESP, Cmd.SESS_KEY_NEG_FINISH]);

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

let crcTable: Uint32Array | undefined;

export function crc32(data: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
    return crypto.createHmac('sha256', key).update(data).digest();
}

export function aesEcbEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(pad);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** Lenient PKCS#7 removal, like TinyTuya: the last byte is trusted when it is a plausible pad length. */
export function aesEcbDecrypt(key: Buffer, data: Buffer, unpad = true): Buffer {
    if (data.length === 0 || data.length % 16 !== 0) {
        throw new ProtocolError(`invalid ciphertext length ${data.length}`);
    }
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    const raw = Buffer.concat([decipher.update(data), decipher.final()]);
    if (!unpad) {
        return raw;
    }
    const padLen = raw[raw.length - 1];
    if (padLen < 1 || padLen > 16) {
        throw new ProtocolError('invalid padding (wrong local key?)');
    }
    return raw.subarray(0, raw.length - padLen);
}

/** Returns ciphertext followed by the 16-byte authentication tag. */
export function gcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
    if (aad && aad.length > 0) {
        cipher.setAAD(aad);
    }
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
}

export function gcmDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad?: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
    if (aad && aad.length > 0) {
        decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function u32(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
}

export function versionHeader(version: ProtocolVersion): Buffer {
    return Buffer.concat([Buffer.from(version, 'latin1'), Buffer.alloc(12)]);
}

// ---------------------------------------------------------------------------------------------
// Session key negotiation (3.4 and 3.5)
// ---------------------------------------------------------------------------------------------

export function needsSessionKey(version: ProtocolVersion): boolean {
    return version !== '3.3';
}

/** Step 2 of the handshake: checks the device's answer and returns its nonce. */
export function verifyNegotiationResponse(localKey: Buffer, localNonce: Buffer, payload: Buffer): Buffer {
    if (payload.length < 48) {
        throw new ProtocolError(`session negotiation answer too short (${payload.length} bytes)`);
    }
    const remoteNonce = payload.subarray(0, 16);
    const expected = hmacSha256(localKey, localNonce);
    if (!crypto.timingSafeEqual(expected, payload.subarray(16, 48))) {
        throw new ProtocolError('session negotiation failed: HMAC mismatch (wrong local key?)');
    }
    return Buffer.from(remoteNonce);
}

/** Step 3 payload: proves to the device that we know the local key. */
export function negotiationFinishPayload(localKey: Buffer, remoteNonce: Buffer): Buffer {
    return hmacSha256(localKey, remoteNonce);
}

export function deriveSessionKey(version: ProtocolVersion, localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
    const mixed = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        mixed[i] = localNonce[i] ^ remoteNonce[i];
    }
    if (version === '3.4') {
        return aesEcbEncrypt(localKey, mixed, false);
    }
    if (version === '3.5') {
        // ciphertext only (the first 16 bytes), no AAD
        return gcmEncrypt(localKey, localNonce.subarray(0, 12), mixed).subarray(0, 16);
    }
    throw new ProtocolError(`protocol ${version} has no session key`);
}

/** Builds a raw 6699 (AES-GCM) frame. Used for 3.5 traffic and for the UDP discovery request. */
export function encode6699(key: Buffer, seq: number, cmd: number, plaintext: Buffer, iv?: Buffer): Buffer {
    const nonce = iv ?? crypto.randomBytes(12);
    const aad = Buffer.concat([Buffer.alloc(2), u32(seq), u32(cmd), u32(12 + plaintext.length + 16)]);
    const sealed = gcmEncrypt(key, nonce, plaintext, aad);
    return Buffer.concat([u32(PREFIX_6699), aad, nonce, sealed, u32(SUFFIX_6699)]);
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

export interface Frame {
    seq: number;
    cmd: number;
    /** Return code sent by the device (0 = success). */
    retcode: number;
    /** Decrypted payload, version header removed. Empty for bare acknowledgements. */
    payload: Buffer;
}

export type Role = 'client' | 'device';

export class TuyaCodec {
    private sessionKey: Buffer | null = null;
    private pending: Buffer = Buffer.alloc(0);

    /**
     * `role` is who is speaking: a client (us) sends bare frames, a device prefixes its answers with a return code.
     * The device role only exists so tests can run a simulated device.
     */
    constructor(public readonly version: ProtocolVersion, private readonly localKey: Buffer, private readonly role: Role = 'client') {
        if (localKey.length !== 16) {
            throw new ProtocolError(`local key must be 16 bytes, got ${localKey.length}`);
        }
    }

    /** Switches to the key negotiated with the device (3.4 / 3.5). */
    useSessionKey(key: Buffer | null) {
        this.sessionKey = key;
    }

    private get key(): Buffer {
        return this.sessionKey ?? this.localKey;
    }

    /** `iv` is only meant for tests (3.5); a random one is used otherwise. */
    encode(cmd: number, seq: number, payload: Buffer, iv?: Buffer): Buffer {
        const key = this.key;
        const retcode = this.role === 'device' ? u32(0) : Buffer.alloc(0);
        // a bare acknowledgement has nothing to protect: no version header, no ciphertext
        const bare = this.role === 'device' && payload.length === 0;

        if (this.version === '3.3') {
            // 3.3: the version header travels in clear, in front of the encrypted JSON
            let wire: Buffer = Buffer.alloc(0);
            if (!bare) {
                const enc = aesEcbEncrypt(key, payload);
                wire = NO_VERSION_HEADER.has(cmd) ? enc : Buffer.concat([versionHeader('3.3'), enc]);
            }
            const head = Buffer.concat([u32(PREFIX_55AA), u32(seq), u32(cmd), u32(retcode.length + wire.length + 8)]);
            const withBody = Buffer.concat([head, retcode, wire]);
            return Buffer.concat([withBody, u32(crc32(withBody)), u32(SUFFIX_55AA)]);
        }

        const body = NO_VERSION_HEADER.has(cmd) || bare ? payload : Buffer.concat([versionHeader(this.version), payload]);

        if (this.version === '3.4') {
            const enc = bare ? Buffer.alloc(0) : aesEcbEncrypt(key, body);
            const head = Buffer.concat([u32(PREFIX_55AA), u32(seq), u32(cmd), u32(retcode.length + enc.length + 32 + 4)]);
            const withBody = Buffer.concat([head, retcode, enc]);
            return Buffer.concat([withBody, hmacSha256(key, withBody), u32(SUFFIX_55AA)]);
        }

        return encode6699(key, seq, cmd, Buffer.concat([retcode, body]), iv);
    }

    /**
     * Feeds raw TCP bytes and returns every complete, valid frame. Partial frames are kept for the next call;
     * corrupt ones are dropped and reported in `errors`.
     */
    decode(chunk: Buffer): { frames: Frame[]; errors: string[] } {
        const frames: Frame[] = [];
        const errors: string[] = [];
        this.decodeEach(chunk, (frame) => frames.push(frame), (message) => errors.push(message));
        return { frames, errors };
    }

    /**
     * Same as `decode`, but hands frames over one at a time. A handler may call `useSessionKey()`, and the very next
     * frame of the same TCP read is then decoded with the new key: the handshake and the first request can arrive together.
     */
    decodeEach(chunk: Buffer, onFrame: (frame: Frame) => void, onError: (message: string) => void = () => undefined) {
        this.pending = Buffer.concat([this.pending, chunk]);

        for (;;) {
            const start = this.findPrefix();
            if (start < 0) {
                // keep the last 3 bytes: they may be the beginning of a prefix split across two reads
                this.pending = this.pending.subarray(Math.max(0, this.pending.length - 3));
                return;
            }
            if (start > 0) {
                this.pending = this.pending.subarray(start);
            }

            const is6699 = this.pending.readUInt32BE(0) === PREFIX_6699;
            const headerLen = is6699 ? HEADER_LEN_6699 : HEADER_LEN_55AA;
            if (is6699 !== (this.version === '3.5')) {
                // like a real device or client, ignore the other protocol family instead of trying to be clever
                onError(`ignored a ${is6699 ? '6699' : '55AA'} frame: not used by protocol ${this.version}`);
                this.pending = this.pending.subarray(4);
                continue;
            }
            if (this.pending.length < headerLen) {
                return;
            }
            const length = this.pending.readUInt32BE(headerLen - 4);
            if (length > MAX_PAYLOAD_LENGTH) {
                onError(`implausible frame length ${length}, resynchronising`);
                this.pending = this.pending.subarray(4);
                continue;
            }
            const total = headerLen + length + (is6699 ? 4 : 0);
            if (this.pending.length < total) {
                return;
            }
            const raw = this.pending.subarray(0, total);
            this.pending = this.pending.subarray(total);

            let frame: Frame;
            try {
                frame = is6699 ? this.decode6699(raw) : this.decode55AA(raw);
            } catch (e) {
                onError((e as Error).message);
                continue;
            }
            onFrame(frame);
        }
    }

    /** Drops any buffered partial frame (call when the connection is re-established). */
    reset() {
        this.pending = Buffer.alloc(0);
        this.sessionKey = null;
    }

    private findPrefix(): number {
        const a = this.pending.indexOf(Buffer.from([0x00, 0x00, 0x55, 0xaa]));
        const b = this.pending.indexOf(Buffer.from([0x00, 0x00, 0x66, 0x99]));
        if (a < 0) {
            return b;
        }
        if (b < 0) {
            return a;
        }
        return Math.min(a, b);
    }

    private decode55AA(raw: Buffer): Frame {
        const seq = raw.readUInt32BE(4);
        const cmd = raw.readUInt32BE(8);
        const length = raw.readUInt32BE(12);
        const useHmac = this.version === '3.4';
        const endLen = (useHmac ? 32 : 4) + 4;
        if (length < (this.role === 'client' ? 4 : 0) + endLen) {
            throw new ProtocolError(`frame too short (cmd ${cmd})`);
        }

        const signedEnd = HEADER_LEN_55AA + length - endLen;
        const signed = raw.subarray(0, signedEnd);
        const sig = raw.subarray(signedEnd, signedEnd + endLen - 4);
        if (useHmac) {
            if (!crypto.timingSafeEqual(hmacSha256(this.key, signed), sig)) {
                throw new ProtocolError(`bad HMAC on frame cmd ${cmd}`);
            }
        } else if (crc32(signed) !== sig.readUInt32BE(0)) {
            throw new ProtocolError(`bad CRC on frame cmd ${cmd}`);
        }

        const hasRetcode = this.role === 'client';
        const retcode = hasRetcode ? raw.readUInt32BE(HEADER_LEN_55AA) : 0;
        let payload: Buffer = raw.subarray(HEADER_LEN_55AA + (hasRetcode ? 4 : 0), signedEnd);

        if (this.version === '3.3') {
            payload = this.stripVersionHeader(cmd, payload);
            payload = payload.length > 0 ? aesEcbDecrypt(this.key, payload) : payload;
        } else {
            payload = payload.length > 0 ? aesEcbDecrypt(this.key, payload) : payload;
            payload = this.stripVersionHeader(cmd, payload);
        }
        return { seq, cmd, retcode, payload: Buffer.from(payload) };
    }

    private decode6699(raw: Buffer): Frame {
        const aad = raw.subarray(4, HEADER_LEN_6699);
        const seq = raw.readUInt32BE(6);
        const cmd = raw.readUInt32BE(10);
        const iv = raw.subarray(HEADER_LEN_6699, HEADER_LEN_6699 + 12);
        const tag = raw.subarray(raw.length - 4 - 16, raw.length - 4);
        const cipherText = raw.subarray(HEADER_LEN_6699 + 12, raw.length - 4 - 16);
        if (raw.length < HEADER_LEN_6699 + 12 + 16 + 4) {
            throw new ProtocolError(`frame too short (cmd ${cmd})`);
        }

        let plain: Buffer;
        try {
            plain = gcmDecrypt(this.key, iv, cipherText, tag, aad);
        } catch {
            throw new ProtocolError(`GCM authentication failed on frame cmd ${cmd}`);
        }
        const hasRetcode = this.role === 'client';
        if (plain.length < (hasRetcode ? 4 : 0)) {
            throw new ProtocolError(`frame too short (cmd ${cmd})`);
        }
        const retcode = hasRetcode ? plain.readUInt32BE(0) : 0;
        const payload = this.stripVersionHeader(cmd, plain.subarray(hasRetcode ? 4 : 0));
        return { seq, cmd, retcode, payload: Buffer.from(payload) };
    }

    private stripVersionHeader(cmd: number, payload: Buffer): Buffer {
        if (NEGOTIATION_CMDS.has(cmd)) {
            return payload;
        }
        const tag = Buffer.from(this.version, 'latin1');
        if (payload.length >= 15 && payload.subarray(0, 3).equals(tag)) {
            return payload.subarray(15);
        }
        return payload;
    }
}

// ---------------------------------------------------------------------------------------------
// Command payloads (JSON)
// ---------------------------------------------------------------------------------------------

export type Dps = Record<string, unknown>;

export interface OutgoingMessage {
    cmd: number;
    payload: Buffer;
}

function json(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value), 'utf8');
}

/** `now` is injectable so tests can compare against fixed fixtures. */
export function buildQuery(version: ProtocolVersion, devId: string, now = Math.floor(Date.now() / 1000)): OutgoingMessage {
    if (version === '3.3') {
        return { cmd: Cmd.DP_QUERY, payload: json({ gwId: devId, devId, uid: devId, t: String(now) }) };
    }
    return { cmd: Cmd.DP_QUERY_NEW, payload: json({}) };
}

export function buildControl(version: ProtocolVersion, devId: string, dps: Dps, now = Math.floor(Date.now() / 1000)): OutgoingMessage {
    if (version === '3.3') {
        return { cmd: Cmd.CONTROL, payload: json({ devId, uid: devId, t: String(now), dps }) };
    }
    return { cmd: Cmd.CONTROL_NEW, payload: json({ protocol: 5, t: now, data: { dps } }) };
}

export function buildHeartbeat(devId: string): OutgoingMessage {
    return { cmd: Cmd.HEART_BEAT, payload: json({ gwId: devId, devId }) };
}

/** Extracts the data points from a decoded payload, whatever the protocol version nests them in. */
export function extractDps(payload: Buffer): Dps | null {
    if (payload.length === 0) {
        return null;
    }
    let parsed: any;
    try {
        parsed = JSON.parse(payload.toString('utf8'));
    } catch {
        return null;
    }
    if (parsed && typeof parsed === 'object') {
        if (parsed.dps && typeof parsed.dps === 'object') {
            return parsed.dps as Dps;
        }
        if (parsed.data && typeof parsed.data === 'object' && parsed.data.dps && typeof parsed.data.dps === 'object') {
            return parsed.data.dps as Dps;
        }
    }
    return null;
}
