/**
 * A persistent local (LAN) connection to one Tuya device.
 *
 * It connects, negotiates the session key when the protocol needs one, reads the current data points,
 * keeps the link alive with heartbeats, applies the changes the device pushes, and reconnects on its own.
 * Requests are sent one at a time because the device answers without echoing our sequence number (3.5).
 */
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as net from 'net';
import {
    Cmd, Dps, Frame, PROTOCOL_VERSIONS, ProtocolError, ProtocolVersion, TuyaCodec, buildControl, buildHeartbeat, buildQuery,
    deriveSessionKey, extractDps, needsSessionKey, negotiationFinishPayload, verifyNegotiationResponse,
} from './protocol';

export interface DeviceLog {
    debug(message: string, ...parameters: any[]): void;
    info(message: string, ...parameters: any[]): void;
    warn(message: string, ...parameters: any[]): void;
    error(message: string, ...parameters: any[]): void;
}

export type TuyaErrorKind =
    | 'connection' // TCP level: unreachable, refused, closed
    | 'timeout'    // connected, but the device did not answer: wrong protocol version or wrong local key
    | 'device';    // the device answered with an error

export class TuyaError extends Error {
    constructor(message: string, public readonly kind: TuyaErrorKind) {
        super(message);
    }
}

export interface TuyaDeviceOptions {
    id: string;
    /** The 16-character local key. */
    key: string;
    ip: string;
    /** Protocol version if known; detected automatically otherwise. */
    version?: ProtocolVersion;
    /** Treat `version` as certain and never try another one. */
    lockVersion?: boolean;
    port?: number;
    log: DeviceLog;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    heartbeatMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
}

interface Pending {
    expect: Set<number>;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface DeviceEvents {
    /** Emitted once the link is up and the first status has been read. */
    connected: [version: ProtocolVersion];
    disconnected: [];
    /** Data points that changed (all of them right after connecting). */
    dps: [changed: Dps, all: Dps];
    /** A connection attempt failed; `count` is the number of failures in a row. */
    'connect-failed': [error: Error, count: number];
}

type Listener<K extends keyof DeviceEvents> = (...args: DeviceEvents[K]) => void;

const DEFAULTS = {
    port: 6668,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 4000,
    heartbeatMs: 10000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30000,
};

/** After this many failed attempts with a known version, forget it and detect again (firmware update?). */
const FORGET_VERSION_AFTER = 3;

export class TuyaDevice extends EventEmitter {
    /** Last known value of every data point. */
    dps: Dps = {};
    version?: ProtocolVersion;

    private ip: string;
    private readonly opts: Required<Omit<TuyaDeviceOptions, 'version' | 'lockVersion' | 'log' | 'id' | 'key' | 'ip'>>;
    private readonly log: DeviceLog;
    private readonly key: Buffer;

    private socket?: net.Socket;
    private codec?: TuyaCodec;
    private seq = 0;
    private pending: Pending[] = [];
    private queue: Promise<unknown> = Promise.resolve();

    private ready = false;
    private connecting = false;
    private stopped = true;
    private failures = 0;
    private heartbeatTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;

    constructor(private readonly options: TuyaDeviceOptions) {
        super();
        this.log = options.log;
        this.ip = options.ip;
        this.version = options.version;
        this.key = Buffer.from(options.key, 'latin1');
        if (this.key.length !== 16) {
            throw new Error(`The local key of ${options.id} must be 16 characters long (got ${this.key.length})`);
        }
        this.opts = {
            port: options.port ?? DEFAULTS.port,
            connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
            heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
            reconnectBaseMs: options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
            reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
        };
    }

    // typed wrappers over EventEmitter, so a typo in an event name or a wrong listener signature does not compile
    on<K extends keyof DeviceEvents>(event: K, listener: Listener<K>): this {
        return super.on(event, listener as (...args: any[]) => void);
    }

    once<K extends keyof DeviceEvents>(event: K, listener: Listener<K>): this {
        return super.once(event, listener as (...args: any[]) => void);
    }

    emit<K extends keyof DeviceEvents>(event: K, ...args: DeviceEvents[K]): boolean {
        return super.emit(event, ...args);
    }

    get id(): string {
        return this.options.id;
    }

    get address(): string {
        return this.ip;
    }

    get isReady(): boolean {
        return this.ready;
    }

    /** Starts connecting (and keeps reconnecting until `stop()`). */
    start() {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        void this.connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        this.teardown(new TuyaError('stopped', 'connection'));
    }

    /** The device moved to another IP address (DHCP): reconnect there right away. */
    setAddress(ip: string) {
        if (ip === this.ip) {
            return;
        }
        this.log.debug(`address changed ${this.ip} -> ${ip}`);
        this.ip = ip;
        if (this.stopped) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        this.teardown(new TuyaError('address changed', 'connection'));
        this.failures = 0;
        void this.connect();
    }

    /** Sends data points to the device and resolves once it acknowledged them. */
    set(dps: Dps): Promise<void> {
        return this.enqueue(async () => {
            const version = this.requireVersion();
            const message = buildControl(version, this.id, dps);
            // some firmwares only answer with a status push, so that counts as an acknowledgement too
            const reply = await this.request(message.cmd, message.payload, [message.cmd, Cmd.STATUS]);
            this.mergeDps(Object.fromEntries(Object.entries(dps)));
            this.log.debug(`set ${JSON.stringify(dps)} acknowledged (cmd ${reply.cmd})`);
        });
    }

    /** Re-reads every data point from the device. */
    refresh(): Promise<Dps> {
        return this.enqueue(async () => {
            await this.query(this.requireVersion());
            return this.dps;
        });
    }

    // ---------------------------------------------------------------------------------------
    // Connection life cycle
    // ---------------------------------------------------------------------------------------

    private requireVersion(): ProtocolVersion {
        if (!this.ready || !this.version) {
            throw new TuyaError('the light is not connected', 'connection');
        }
        return this.version;
    }

    private async connect() {
        if (this.stopped || this.connecting) {
            return;
        }
        this.connecting = true;
        const candidates = this.version ? [this.version] : PROTOCOL_VERSIONS;
        let lastError: Error = new TuyaError('could not connect', 'connection');

        for (const version of candidates) {
            try {
                await this.open(version);
                this.version = version;
                this.connecting = false;
                this.failures = 0;
                this.startHeartbeat();
                this.log.debug(`connected to ${this.ip} with protocol ${version}`);
                this.emit('connected', version);
                this.emit('dps', { ...this.dps }, this.dps);
                return;
            } catch (e) {
                lastError = e as Error;
                this.dropSocket();
                this.log.debug(`protocol ${version} failed: ${lastError.message}`);
                if (lastError instanceof TuyaError && lastError.kind === 'connection') {
                    break; // the network is the problem, another protocol version will not help
                }
            }
        }

        this.connecting = false;
        this.failures++;
        if (this.version && this.failures >= FORGET_VERSION_AFTER && !this.options.lockVersion) {
            this.version = undefined;
        }
        this.emit('connect-failed', lastError, this.failures);
        this.scheduleReconnect();
    }

    private async open(version: ProtocolVersion) {
        const socket = await this.dial();
        const codec = new TuyaCodec(version, this.key);
        this.socket = socket;
        this.codec = codec;
        this.seq = 0;

        socket.on('data', (chunk) => this.onData(socket, chunk));
        socket.on('close', () => this.onClose(socket));
        socket.on('error', (e) => this.log.debug(`socket error: ${e.message}`));

        try {
            if (needsSessionKey(version)) {
                await this.negotiate(version, codec);
            }
            await this.query(version);
        } catch (e) {
            if (e instanceof ProtocolError) {
                throw new TuyaError(e.message, 'timeout');
            }
            throw e;
        }
        this.ready = true;
    }

    private dial(): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host: this.ip, port: this.opts.port });
            socket.setNoDelay(true);
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new TuyaError(`connecting to ${this.ip}:${this.opts.port} timed out`, 'connection'));
            }, this.opts.connectTimeoutMs);
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.setKeepAlive(true, 15000);
                resolve(socket);
            });
            socket.on('error', (e) => {
                clearTimeout(timer);
                reject(new TuyaError(`cannot connect to ${this.ip}:${this.opts.port}: ${e.message}`, 'connection'));
            });
        });
    }

    private async negotiate(version: ProtocolVersion, codec: TuyaCodec) {
        const localNonce = crypto.randomBytes(16);
        const answer = await this.request(Cmd.SESS_KEY_NEG_START, localNonce, [Cmd.SESS_KEY_NEG_RESP]);
        const remoteNonce = verifyNegotiationResponse(this.key, localNonce, answer.payload);
        await this.write(Cmd.SESS_KEY_NEG_FINISH, negotiationFinishPayload(this.key, remoteNonce));
        codec.useSessionKey(deriveSessionKey(version, this.key, localNonce, remoteNonce));
    }

    private async query(version: ProtocolVersion) {
        const message = buildQuery(version, this.id);
        const reply = await this.request(message.cmd, message.payload, [message.cmd, Cmd.STATUS]);
        if (!extractDps(reply.payload) && Object.keys(this.dps).length === 0) {
            throw new TuyaError('the device did not return its status (wrong local key?)', 'timeout');
        }
    }

    private startHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            this.enqueue(async () => {
                const beat = buildHeartbeat(this.id);
                await this.request(beat.cmd, beat.payload, [Cmd.HEART_BEAT]);
            }).catch((e: Error) => {
                this.log.debug(`heartbeat failed (${e.message}), reconnecting`);
                this.socket?.destroy();
            });
        }, this.opts.heartbeatMs);
    }

    private scheduleReconnect() {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        const delay = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectBaseMs * 2 ** Math.max(0, this.failures - 1));
        const jittered = delay + Math.random() * delay * 0.2;
        this.log.debug(`reconnecting in ${Math.round(jittered)} ms`);
        this.reconnectTimer = setTimeout(() => void this.connect(), jittered);
    }

    private onClose(socket: net.Socket) {
        if (socket !== this.socket) {
            return;
        }
        const wasReady = this.ready;
        this.teardown(new TuyaError('connection closed', 'connection'));
        if (wasReady) {
            this.emit('disconnected');
        }
        if (!this.stopped && !this.connecting) {
            this.scheduleReconnect();
        }
    }

    /** Forgets the socket without waiting for its close event. */
    private dropSocket() {
        const socket = this.socket;
        this.socket = undefined;
        this.codec = undefined;
        this.ready = false;
        socket?.destroy();
        this.failPending(new TuyaError('connection closed', 'connection'));
    }

    private teardown(reason: Error) {
        clearInterval(this.heartbeatTimer);
        this.ready = false;
        const socket = this.socket;
        this.socket = undefined;
        this.codec = undefined;
        socket?.destroy();
        this.failPending(reason);
    }

    // ---------------------------------------------------------------------------------------
    // Requests and incoming frames
    // ---------------------------------------------------------------------------------------

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = this.queue.then(job, job);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private write(cmd: number, payload: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            const { socket, codec } = this;
            if (!socket || socket.destroyed || !codec) {
                reject(new TuyaError('not connected', 'connection'));
                return;
            }
            socket.write(codec.encode(cmd, ++this.seq, payload), (err) => {
                if (err) {
                    reject(new TuyaError(`write failed: ${err.message}`, 'connection'));
                } else {
                    resolve();
                }
            });
        });
    }

    private request(cmd: number, payload: Buffer, expect: number[]): Promise<Frame> {
        return new Promise((resolve, reject) => {
            const entry: Pending = {
                expect: new Set(expect),
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.pending = this.pending.filter((p) => p !== entry);
                    reject(new TuyaError(`no answer from the device to command ${cmd}`, 'timeout'));
                }, this.opts.requestTimeoutMs),
            };
            this.pending.push(entry);
            this.write(cmd, payload).catch((e) => {
                clearTimeout(entry.timer);
                this.pending = this.pending.filter((p) => p !== entry);
                reject(e);
            });
        });
    }

    private failPending(reason: Error) {
        const pending = this.pending;
        this.pending = [];
        for (const p of pending) {
            clearTimeout(p.timer);
            p.reject(reason);
        }
    }

    private onData(socket: net.Socket, chunk: Buffer) {
        const codec = this.codec;
        if (socket !== this.socket || !codec) {
            return;
        }
        codec.decodeEach(
            chunk,
            (frame) => this.onFrame(frame),
            (message) => this.log.debug(`dropped a frame: ${message}`),
        );
    }

    private onFrame(frame: Frame) {
        this.log.debug(`<- cmd ${frame.cmd} retcode ${frame.retcode} ${frame.payload.length} bytes`);

        const dps = extractDps(frame.payload);
        if (dps) {
            this.mergeDps(dps);
        }

        const index = this.pending.findIndex((p) => p.expect.has(frame.cmd));
        if (index >= 0) {
            const [entry] = this.pending.splice(index, 1);
            clearTimeout(entry.timer);
            if (frame.retcode !== 0 && !dps) {
                entry.reject(new TuyaError(`the device refused the command (code ${frame.retcode})`, 'device'));
            } else {
                entry.resolve(frame);
            }
        }
    }

    private mergeDps(incoming: Dps) {
        const changed: Dps = {};
        for (const [key, value] of Object.entries(incoming)) {
            if (JSON.stringify(this.dps[key]) !== JSON.stringify(value)) {
                changed[key] = value;
            }
        }
        this.dps = { ...this.dps, ...incoming };
        if (Object.keys(changed).length > 0 && this.ready) {
            this.emit('dps', changed, this.dps);
        }
    }
}
