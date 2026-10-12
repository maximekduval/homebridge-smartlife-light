import * as crypto from 'crypto';
import * as net from 'net';
import {
    Cmd, Dps, ProtocolVersion, TuyaCodec, deriveSessionKey, extractDps, hmacSha256, needsSessionKey,
} from '../../src/tuya/protocol';

/**
 * A Tuya device simulated on localhost. It speaks the real wire protocol (the codec is checked against TinyTuya
 * in protocol.test.ts), so the client under test cannot cheat: wrong version or key means silence, like on hardware.
 */
export class FakeTuyaDevice {
    readonly server: net.Server;
    readonly connections = new Set<net.Socket>();
    port = 0;
    heartbeats = 0;
    controls: Dps[] = [];
    /** Answer control commands with an acknowledgement. */
    ack = true;
    /** Push the new state after a control command, like real firmwares do. */
    pushOnControl = true;
    /** Never answer anything (frozen device). */
    mute = false;
    /** Lets a test emulate the firmware's side effects: receives what was asked and may return extra changes. */
    quirks?: (requested: Dps, current: Dps) => Dps;

    private readonly key: Buffer;

    constructor(readonly id: string, key: string, readonly version: ProtocolVersion, public dps: Dps) {
        this.key = Buffer.from(key, 'latin1');
        this.server = net.createServer((socket) => this.accept(socket));
    }

    listen(): Promise<number> {
        return new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                this.port = (this.server.address() as net.AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    close(): Promise<void> {
        for (const socket of this.connections) {
            socket.destroy();
        }
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    /** Drops every client, as if the Wi-Fi blinked. */
    dropConnections() {
        for (const socket of this.connections) {
            socket.destroy();
        }
    }

    /** Changes the state on the device side (someone pressed the wall switch) and tells the clients. */
    push(dps: Dps) {
        this.dps = { ...this.dps, ...dps };
        for (const send of this.senders.values()) {
            send(Cmd.STATUS, Buffer.from(JSON.stringify({ dps, t: Math.floor(Date.now() / 1000) })));
        }
    }

    private senders = new Map<net.Socket, (cmd: number, payload: Buffer) => void>();

    private accept(socket: net.Socket) {
        this.connections.add(socket);
        socket.on('close', () => {
            this.connections.delete(socket);
            this.senders.delete(socket);
        });
        socket.on('error', () => undefined);

        const codec = new TuyaCodec(this.version, this.key, 'device');
        let seq = 1000;
        let localNonce = Buffer.alloc(0);
        let remoteNonce = Buffer.alloc(0);

        const send = (cmd: number, payload: Buffer, replySeq?: number) => {
            if (!socket.destroyed) {
                socket.write(codec.encode(cmd, replySeq ?? ++seq, payload));
            }
        };
        this.senders.set(socket, (cmd, payload) => send(cmd, payload));

        socket.on('data', (chunk) => {
            codec.decodeEach(chunk, (frame) => {
                if (this.mute) {
                    return;
                }
                switch (frame.cmd) {
                    case Cmd.SESS_KEY_NEG_START:
                        if (!needsSessionKey(this.version)) {
                            break;
                        }
                        localNonce = Buffer.from(frame.payload);
                        remoteNonce = crypto.randomBytes(16);
                        send(Cmd.SESS_KEY_NEG_RESP, Buffer.concat([remoteNonce, hmacSha256(this.key, localNonce)]), frame.seq);
                        break;
                    case Cmd.SESS_KEY_NEG_FINISH:
                        if (frame.payload.equals(hmacSha256(this.key, remoteNonce))) {
                            codec.useSessionKey(deriveSessionKey(this.version, this.key, localNonce, remoteNonce));
                        }
                        break;
                    case Cmd.DP_QUERY:
                    case Cmd.DP_QUERY_NEW:
                        send(frame.cmd, Buffer.from(JSON.stringify({ devId: this.id, dps: this.dps })), frame.seq);
                        break;
                    case Cmd.CONTROL:
                    case Cmd.CONTROL_NEW: {
                        const requested = extractDps(frame.payload) ?? {};
                        this.controls.push(requested);
                        const side = this.quirks?.(requested, this.dps) ?? {};
                        this.dps = { ...this.dps, ...requested, ...side };
                        if (this.ack) {
                            send(frame.cmd, Buffer.alloc(0), frame.seq);
                        }
                        if (this.pushOnControl) {
                            send(Cmd.STATUS, Buffer.from(JSON.stringify({ dps: { ...requested, ...side }, t: 1 })));
                        }
                        break;
                    }
                    case Cmd.HEART_BEAT:
                        this.heartbeats++;
                        send(Cmd.HEART_BEAT, Buffer.alloc(0), frame.seq);
                        break;
                    default:
                        break;
                }
            });
        });
    }
}
