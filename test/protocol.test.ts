import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    Cmd, ProtocolVersion, TuyaCodec, buildControl, buildHeartbeat, buildQuery, deriveSessionKey, extractDps,
    negotiationFinishPayload, verifyNegotiationResponse,
} from '../src/tuya/protocol';

// Reference frames produced by TinyTuya (test/fixtures/generate.py).
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'frames.json'), 'utf8'));
const hex = (s: string) => Buffer.from(s, 'hex');
const localKey = Buffer.from(fx.localKey, 'latin1');
const FIXED_IV = Buffer.from('0123456789ab', 'latin1');

const VERSIONS: ProtocolVersion[] = ['3.3', '3.4', '3.5'];

function codecFor(version: ProtocolVersion, withSession: boolean) {
    const codec = new TuyaCodec(version, localKey);
    if (withSession && version !== '3.3') {
        codec.useSessionKey(hex(fx['v' + version].neg.sessionKey));
    }
    return codec;
}

describe.each(VERSIONS)('protocol %s', (version) => {
    const entry = fx['v' + version];

    describe('command payloads', () => {
        it('builds the same query as TinyTuya', () => {
            const msg = buildQuery(version, fx.devId, fx.now);
            expect(msg.cmd).toBe(entry.payloads.query.cmd);
            expect(msg.payload.toString('hex')).toBe(entry.payloads.query.payload);
        });

        it('builds the same control command as TinyTuya', () => {
            const msg = buildControl(version, fx.devId, { 20: true, 22: 500 }, fx.now);
            expect(msg.cmd).toBe(entry.payloads.control.cmd);
            expect(msg.payload.toString('hex')).toBe(entry.payloads.control.payload);
        });

        it('builds the same heartbeat as TinyTuya', () => {
            const msg = buildHeartbeat(fx.devId);
            expect(msg.cmd).toBe(entry.payloads.heartbeat.cmd);
            expect(msg.payload.toString('hex')).toBe(entry.payloads.heartbeat.payload);
        });
    });

    describe('encoding', () => {
        for (const name of ['query', 'control', 'heartbeat']) {
            it(`encodes ${name} byte-for-byte like TinyTuya`, () => {
                const codec = codecFor(version, true);
                const p = entry.payloads[name];
                const frame = codec.encode(p.cmd, fx.seq + 2, hex(p.payload), FIXED_IV);
                expect(frame.toString('hex')).toBe(entry.frames[name]);
            });
        }
    });

    describe('decoding device frames', () => {
        for (const name of ['statusPush', 'queryReply', 'controlAck']) {
            it(`decodes ${name}`, () => {
                const inc = entry.incoming[name];
                const { frames, errors } = codecFor(version, true).decode(hex(inc.frame));
                expect(errors).toEqual([]);
                expect(frames).toHaveLength(1);
                expect(frames[0].cmd).toBe(inc.cmd);
                expect(frames[0].retcode).toBe(0);
                if (inc.json === null) {
                    expect(frames[0].payload).toHaveLength(0);
                } else {
                    expect(JSON.parse(frames[0].payload.toString('utf8'))).toEqual(inc.json);
                }
            });
        }

        it('extracts data points from a status push and a query reply', () => {
            const codec = codecFor(version, true);
            const push = codec.decode(hex(entry.incoming.statusPush.frame)).frames[0];
            expect(extractDps(push.payload)).toEqual({ 20: true, 22: 500 });
            const reply = codec.decode(hex(entry.incoming.queryReply.frame)).frames[0];
            expect(extractDps(reply.payload)).toMatchObject({ 20: false, 21: 'white', 22: 10 });
        });

        it('reassembles frames split across TCP reads and glued together', () => {
            const a = hex(entry.incoming.statusPush.frame);
            const b = hex(entry.incoming.queryReply.frame);
            const stream = Buffer.concat([a, b]);

            const codec = codecFor(version, true);
            const got: number[] = [];
            for (let i = 0; i < stream.length; i += 7) {
                got.push(...codec.decode(stream.subarray(i, i + 7)).frames.map((f) => f.cmd));
            }
            expect(got).toEqual([entry.incoming.statusPush.cmd, entry.incoming.queryReply.cmd]);
        });

        it('resynchronises after garbage bytes', () => {
            const frame = hex(entry.incoming.statusPush.frame);
            const { frames } = codecFor(version, true).decode(Buffer.concat([Buffer.from([1, 2, 3, 0, 0, 5]), frame]));
            expect(frames).toHaveLength(1);
        });

        it('rejects a tampered frame instead of returning garbage', () => {
            const frame = Buffer.from(hex(entry.incoming.statusPush.frame));
            frame[frame.length - 12] ^= 0xff;
            const { frames, errors } = codecFor(version, true).decode(frame);
            expect(frames).toHaveLength(0);
            expect(errors).toHaveLength(1);
        });

        it('rejects frames encrypted with another key', () => {
            const other = new TuyaCodec(version, Buffer.from('ffffffffffffffff', 'latin1'));
            const { frames, errors } = other.decode(hex(entry.incoming.statusPush.frame));
            expect(frames).toHaveLength(0);
            expect(errors.length).toBeGreaterThan(0);
        });
    });
});

describe.each(['3.4', '3.5'] as ProtocolVersion[])('session key negotiation %s', (version) => {
    const neg = fx['v' + version].neg;
    const localNonce = hex(fx.localNonce);
    const remoteNonce = hex(fx.remoteNonce);

    it('sends the same START frame as TinyTuya', () => {
        const frame = new TuyaCodec(version, localKey).encode(Cmd.SESS_KEY_NEG_START, fx.seq, localNonce, FIXED_IV);
        expect(frame.toString('hex')).toBe(neg.start);
    });

    it('reads the device answer and recovers its nonce', () => {
        const { frames, errors } = new TuyaCodec(version, localKey).decode(hex(neg.response));
        expect(errors).toEqual([]);
        expect(frames[0].cmd).toBe(Cmd.SESS_KEY_NEG_RESP);
        expect(verifyNegotiationResponse(localKey, localNonce, frames[0].payload)).toEqual(remoteNonce);
    });

    it('refuses an answer computed with another local key', () => {
        const forged = Buffer.concat([remoteNonce, Buffer.alloc(32)]);
        expect(() => verifyNegotiationResponse(localKey, localNonce, forged)).toThrow(/HMAC/);
    });

    it('sends the same FINISH frame as TinyTuya', () => {
        const payload = negotiationFinishPayload(localKey, remoteNonce);
        expect(payload.toString('hex')).toBe(neg.finishPayload);
        const frame = new TuyaCodec(version, localKey).encode(Cmd.SESS_KEY_NEG_FINISH, fx.seq + 1, payload, FIXED_IV);
        expect(frame.toString('hex')).toBe(neg.finish);
    });

    it('derives the same session key as TinyTuya', () => {
        expect(deriveSessionKey(version, localKey, localNonce, remoteNonce).toString('hex')).toBe(neg.sessionKey);
    });
});

describe('TuyaCodec', () => {
    it('rejects a local key of the wrong size', () => {
        expect(() => new TuyaCodec('3.3', Buffer.from('short'))).toThrow(/16 bytes/);
    });

    it('uses a fresh random IV for every 3.5 frame', () => {
        const codec = new TuyaCodec('3.5', localKey);
        const payload = Buffer.from('{"gwId":"x","devId":"x"}');
        const a = codec.encode(Cmd.HEART_BEAT, 1, payload);
        const b = codec.encode(Cmd.HEART_BEAT, 1, payload);
        expect(a.equals(b)).toBe(false);
        const decoded = new TuyaCodec('3.5', localKey).decode(a);
        // a client frame has no return code, so its first 4 plaintext bytes get read as one: only check it authenticates
        expect(decoded.errors).toEqual([]);
        expect(decoded.frames).toHaveLength(1);
    });
});
