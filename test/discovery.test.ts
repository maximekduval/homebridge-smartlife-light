import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UDP_KEY, buildDiscoveryRequest, decodeBroadcast } from '../src/tuya/discovery';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'frames.json'), 'utf8'));
const udp = fx.udp;
const hex = (s: string) => Buffer.from(s, 'hex');

describe('UDP discovery', () => {
    it('uses the same broadcast key as TinyTuya', () => {
        expect(UDP_KEY.toString('hex')).toBe(udp.key);
    });

    for (const [name, label] of [['plain6666', 'protocol 3.1 (port 6666)'], ['encrypted6667', 'protocol 3.3/3.4 (port 6667)'], ['app7000', 'protocol 3.5 (port 7000)']]) {
        it(`reads an announcement from ${label}`, () => {
            expect(decodeBroadcast(hex(udp[name]))).toEqual({
                id: udp.announce.gwId,
                ip: udp.announce.ip,
                version: '3.3',
                productKey: udp.announce.productKey,
            });
        });
    }

    it('builds the same discovery request as TinyTuya', () => {
        const frame = buildDiscoveryRequest(udp.requestIp, Buffer.from('0123456789ab', 'latin1'));
        expect(frame.toString('hex')).toBe(udp.request);
    });

    it('ignores datagrams that are not Tuya announcements', () => {
        expect(decodeBroadcast(Buffer.from('hello world, this is not tuya at all'))).toBeNull();
        expect(decodeBroadcast(Buffer.alloc(8))).toBeNull();
        expect(decodeBroadcast(Buffer.from('{"foo":"bar","padding":"............"}'))).toBeNull();
    });
});
