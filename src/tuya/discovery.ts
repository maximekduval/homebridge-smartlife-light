/**
 * Finds Tuya devices on the local network, so nobody has to type an IP address.
 *
 * Tuya devices announce themselves by UDP broadcast:
 *  - port 6666: protocol 3.1, JSON in clear,
 *  - port 6667: protocols 3.3 / 3.4, AES-ECB with a well-known key,
 *  - port 7000: protocol 3.5 devices only answer when an app asks for it, so we broadcast a request there.
 *
 * The announcement carries the device id (`gwId`) and its IP, which is all we need to connect.
 */
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as os from 'os';
import {
    Cmd, PREFIX_55AA, PREFIX_6699, PROTOCOL_VERSIONS, ProtocolVersion, aesEcbDecrypt, encode6699, gcmDecrypt,
} from './protocol';

/** Key shared by every Tuya device for its broadcasts (md5 of a constant string baked into the firmware). */
export const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

export const UDP_PORTS = [6666, 6667, 7000];

export interface Broadcast {
    id: string;
    ip: string;
    version?: ProtocolVersion;
    productKey?: string;
}

/** Decodes one UDP datagram. Returns null for anything that is not a Tuya announcement. */
export function decodeBroadcast(msg: Buffer): Broadcast | null {
    try {
        const json = JSON.parse(extractText(msg));
        if (!json || typeof json.gwId !== 'string' || typeof json.ip !== 'string') {
            return null;
        }
        const broadcast: Broadcast = { id: json.gwId, ip: json.ip };
        if (PROTOCOL_VERSIONS.includes(String(json.version) as ProtocolVersion)) {
            broadcast.version = String(json.version) as ProtocolVersion;
        }
        if (typeof json.productKey === 'string') {
            broadcast.productKey = json.productKey;
        }
        return broadcast;
    } catch {
        return null;
    }
}

function extractText(msg: Buffer): string {
    if (msg.length < 24) {
        throw new Error('datagram too short');
    }
    const prefix = msg.readUInt32BE(0);

    if (prefix === PREFIX_55AA) {
        const length = msg.readUInt32BE(12);
        // header (16) + return code (4) ... crc (4) + suffix (4)
        const payload = msg.subarray(20, 16 + length - 8);
        if (payload[0] === 0x7b) {
            return payload.toString('utf8');
        }
        return aesEcbDecrypt(UDP_KEY, payload).toString('utf8');
    }

    if (prefix === PREFIX_6699) {
        const aad = msg.subarray(4, 18);
        const iv = msg.subarray(18, 30);
        const tag = msg.subarray(msg.length - 20, msg.length - 4);
        let plain = gcmDecrypt(UDP_KEY, iv, msg.subarray(30, msg.length - 20), tag, aad);
        // a 4-byte return code comes first on some devices, and apps pad with NUL bytes
        if (plain[0] !== 0x7b && plain[4] === 0x7b) {
            plain = plain.subarray(4);
        }
        return plain.toString('utf8').replace(/\0+$/, '');
    }

    // some firmwares send the JSON bare
    return msg.toString('utf8');
}

/** What an app broadcasts on port 7000 to make 3.5 devices reveal themselves. */
export function buildDiscoveryRequest(localIp: string, iv?: Buffer): Buffer {
    // JSON spacing deliberately mirrors the reference implementation
    const body = Buffer.from(`{"from": "app", "ip": "${localIp}"}`, 'utf8');
    return encode6699(UDP_KEY, 0, Cmd.REQ_DEVINFO, body, iv);
}

interface Iface {
    address: string;
    broadcast: string;
}

export function broadcastInterfaces(): Iface[] {
    const result: Iface[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const nic of list ?? []) {
            if (nic.family !== 'IPv4' || nic.internal) {
                continue;
            }
            const ip = nic.address.split('.').map(Number);
            const mask = nic.netmask.split('.').map(Number);
            const broadcast = ip.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.');
            result.push({ address: nic.address, broadcast });
        }
    }
    return result;
}

export interface DiscoverOptions {
    /** Stop as soon as all of these ids have been seen. Without it, listen for the whole timeout. */
    ids?: Iterable<string>;
    timeoutMs?: number;
    debug?: (message: string) => void;
}

/** Listens for announcements and returns what was heard, keyed by device id. */
export function discover(options: DiscoverOptions = {}): Promise<Map<string, Broadcast>> {
    const timeoutMs = options.timeoutMs ?? 6000;
    const wanted = options.ids ? new Set(options.ids) : null;
    const found = new Map<string, Broadcast>();
    const debug = options.debug ?? (() => undefined);

    return new Promise((resolve) => {
        const sockets: dgram.Socket[] = [];
        let done = false;

        const finish = () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            clearInterval(ticker);
            for (const s of sockets) {
                try {
                    s.close();
                } catch {
                    // already closed
                }
            }
            resolve(found);
        };

        const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            const broadcast = decodeBroadcast(msg);
            if (!broadcast) {
                return;
            }
            // the packet's source address is more trustworthy than the one the device claims
            if (!broadcast.ip || broadcast.ip === '0.0.0.0') {
                broadcast.ip = rinfo.address;
            }
            if (!found.has(broadcast.id)) {
                debug(`found ${broadcast.id} at ${broadcast.ip} (protocol ${broadcast.version ?? '?'})`);
            }
            found.set(broadcast.id, broadcast);
            if (wanted && [...wanted].every((id) => found.has(id))) {
                finish();
            }
        };

        const interfaces = broadcastInterfaces();
        let appSocket: dgram.Socket | undefined;

        for (const port of UDP_PORTS) {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            socket.on('message', onMessage);
            socket.on('error', (err) => debug(`UDP ${port}: ${err.message}`));
            socket.bind(port, () => {
                try {
                    socket.setBroadcast(true);
                } catch {
                    // not fatal: we only lose the active request on port 7000
                }
            });
            sockets.push(socket);
            if (port === 7000) {
                appSocket = socket;
            }
        }

        const ask = () => {
            for (const iface of interfaces) {
                try {
                    appSocket?.send(buildDiscoveryRequest(iface.address), 7000, iface.broadcast);
                } catch (e) {
                    debug(`discovery request on ${iface.address} failed: ${(e as Error).message}`);
                }
            }
        };
        setTimeout(ask, 200).unref();
        const ticker = setInterval(ask, 3000);
        const timer = setTimeout(finish, timeoutMs);
    });
}
