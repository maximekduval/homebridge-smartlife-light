#!/usr/bin/env node
/**
 * smartlife-light: sets the plugin up (one QR code scan) and inspects lights for troubleshooting.
 *
 *   smartlife-light setup            link your Smart Life account and save your lights
 *   smartlife-light scan             list the Tuya devices announcing themselves on the network
 *   smartlife-light list             show the lights saved by the setup
 *   smartlife-light status <light>   connect to a light and print its data points and how they are read
 *   smartlife-light watch <light>    same, then print every change live (use the Smart Life app and watch what moves)
 *   smartlife-light set <light> 20=true 22=500   write data points
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline/promises';
import * as qrcode from 'qrcode-terminal';

import { CloudDevice, QrScheme, SharingApi, SharingError, SharingLogin, SharingSession, fetchDevices, qrContent } from './cloud/sharing';
import { isLight } from './config';
import { PLATFORM_NAME } from './settings';
import { DeviceStore, LOCAL_FOLDER, STORE_FILE, StoredDevice, findStoragePath } from './store';
import { Broadcast, discover } from './tuya/discovery';
import { TuyaDevice } from './tuya/device';
import { buildProfile, readState } from './tuya/light';
import { Dps } from './tuya/protocol';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

interface Options {
    storage?: string;
    userCode?: string;
    scheme: QrScheme;
    config: boolean;
    debug: boolean;
    positional: string[];
}

function parseArgs(argv: string[]): Options {
    const options: Options = { scheme: 'tuyaSmart', config: true, debug: false, positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--storage': options.storage = argv[++i]; break;
            case '--user-code': options.userCode = argv[++i]; break;
            case '--scheme': options.scheme = argv[++i] === 'smartlife' ? 'smartlife' : 'tuyaSmart'; break;
            case '--no-config': options.config = false; break;
            case '--debug': options.debug = true; break;
            default: options.positional.push(arg);
        }
    }
    return options;
}

const HELP = `
${bold('smartlife-light')}: Smart Life lights in Apple Home

  ${bold('setup')}              Link your Smart Life account (scan a QR code) and save your lights
  ${bold('scan')}               List the Tuya devices announcing themselves on your network
  ${bold('list')}               Show the lights saved by the setup
  ${bold('status')} <light>     Connect to a light, print its data points and how they are understood
  ${bold('watch')} <light>      Same, then print every change live (toggle things in the Smart Life app, type a label + Enter after each)
  ${bold('set')} <light> <dp>=<value> ...   Write data points, for example: set Desk 20=true 22=500

  <light> is the name or the id of a saved light.

Options
  --storage <dir>       Homebridge storage folder (default: found automatically)
  --user-code <code>    Your Smart Life user code (otherwise asked)
  --scheme smartlife    Use the Smart Life QR format if the default one is not accepted by your app
  --no-config           Do not offer to edit Homebridge's config.json
  --debug               Print protocol details
`;

function storagePath(options: Options, create = false): string {
    const dir = options.storage ?? findStoragePath();
    if (dir) {
        return dir;
    }
    if (!create) {
        throw new Error('Could not find the Homebridge storage folder. Pass it with --storage <dir> (it contains config.json).');
    }
    const fallback = path.join(os.homedir(), LOCAL_FOLDER);
    console.log(yellow(`Homebridge does not seem to run on this machine, so the lights will be saved in ${fallback}.`));
    console.log(yellow(`Copy ${STORE_FILE} from there into the Homebridge storage folder of your server (next to config.json).\n`));
    return fallback;
}

async function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------------

async function setup(options: Options) {
    const dir = storagePath(options, true);
    const store = new DeviceStore(dir);

    console.log(`\n${bold('Link your Smart Life account')}\n`);
    console.log('Your lights will be controlled over your own network: the cloud is only used now, once, to read their keys.\n');
    console.log('1. Open the Smart Life app.');
    console.log('2. Tap "Me" (bottom right), then the gear icon (top right), then "Account and Security".');
    console.log('3. Your User Code is at the bottom of that screen.\n');

    const userCode = options.userCode ?? await ask('User Code: ');
    if (!userCode) {
        throw new Error('A user code is required.');
    }

    const login = new SharingLogin();
    const token = await login.requestQrCode(userCode);
    console.log('\nNow scan this QR code with the Smart Life app (tap the scan icon at the top left of "Home", or of "Me"):\n');
    qrcode.generate(qrContent(token, options.scheme), { small: true });
    console.log(dim(`If the app rejects it, run again with --scheme ${options.scheme === 'tuyaSmart' ? 'smartlife' : 'tuyaSmart'}\n`));

    process.stdout.write('Waiting for your approval in the app');
    let session: SharingSession | null = null;
    const deadline = Date.now() + 180_000;
    while (!session && Date.now() < deadline) {
        await sleep(2000);
        process.stdout.write('.');
        session = await login.pollLogin(token, userCode);
    }
    console.log('');
    if (!session) {
        throw new Error('Timed out waiting for the QR code to be scanned. Run the setup again.');
    }
    console.log(green('Approved.') + ' Reading your devices…');

    const api = new SharingApi(session);
    let devices: CloudDevice[];
    try {
        devices = await fetchDevices(api, (m) => console.log(dim(`  ${m}`)));
    } finally {
        await api.logout();
    }

    const lights = devices.filter((d) => isLight({ category: d.category, dps: d.dps }));
    const others = devices.length - lights.length;
    if (lights.length === 0) {
        throw new Error(`No light found among your ${devices.length} device(s). Is the light added to the Smart Life account you used?`);
    }

    const stored: StoredDevice[] = lights.map((d) => ({
        id: d.id,
        name: d.name,
        localKey: d.localKey,
        category: d.category,
        productId: d.productId,
        productName: d.productName,
        dps: d.dps,
    }));
    store.upsert(stored);

    console.log(`\n${bold(`${lights.length} light(s) saved`)} in ${store.file}`);
    for (const d of lights) {
        console.log(`  ${green('●')} ${d.name} ${dim(`(${d.productName || d.category})`)}${d.online ? '' : yellow(' offline in the app')}`);
    }
    if (others > 0) {
        console.log(dim(`  ${others} other device(s) were not saved (not lights).`));
    }

    if (options.config) {
        await offerConfig(dir);
    }
    console.log(`\n${bold('Done.')} Restart Homebridge and the light${lights.length > 1 ? 's appear' : ' appears'} in the Home app.`);
}

async function offerConfig(dir: string) {
    const file = path.join(dir, 'config.json');
    if (!fs.existsSync(file)) {
        console.log(yellow(`\n${file} not found: add { "platform": "${PLATFORM_NAME}" } to "platforms" yourself.`));
        return;
    }
    let config: any;
    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        console.log(yellow(`\nCould not read ${file}: add { "platform": "${PLATFORM_NAME}" } to "platforms" yourself.`));
        return;
    }
    const platforms: any[] = Array.isArray(config.platforms) ? config.platforms : [];
    if (platforms.some((p) => p?.platform === PLATFORM_NAME || String(p?.platform).endsWith(`.${PLATFORM_NAME}`))) {
        console.log(dim('\nThe plugin is already in config.json.'));
        return;
    }
    const answer = (await ask(`\nAdd the plugin to ${file}? A backup is made first. [Y/n] `)).toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') {
        console.log(`Add this to "platforms" in config.json: { "platform": "${PLATFORM_NAME}", "name": "Smart Life Light" }`);
        return;
    }
    fs.copyFileSync(file, `${file}.smartlife-light.bak`);
    config.platforms = [...platforms, { platform: PLATFORM_NAME, name: 'Smart Life Light' }];
    fs.writeFileSync(file, JSON.stringify(config, null, 4) + '\n'); // in place, so the file keeps its owner
    console.log(green('config.json updated.') + dim(` Backup: ${file}.smartlife-light.bak`));
}

// ---------------------------------------------------------------------------------------------
// scan, list
// ---------------------------------------------------------------------------------------------

async function scan(options: Options) {
    let known: StoredDevice[] = [];
    try {
        known = new DeviceStore(storagePath(options)).read().devices;
    } catch {
        // scanning works without a setup
    }
    console.log('Listening for Tuya devices for 10 seconds…');
    const found = await discover({ timeoutMs: 10_000, debug: options.debug ? (m) => console.log(dim(m)) : undefined });
    if (found.size === 0) {
        console.log(yellow('Nothing found. Is this computer on the same Wi-Fi/subnet as the lights? '
            + 'Guest networks and VLANs block broadcasts.'));
        return;
    }
    for (const d of [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))) {
        const name = known.find((k) => k.id === d.id)?.name;
        console.log(`  ${d.ip.padEnd(16)} ${d.id}  protocol ${d.version ?? '?'}  ${name ? green(name) : dim('not saved by the setup')}`);
    }
}

function list(options: Options) {
    const store = new DeviceStore(storagePath(options));
    const { devices } = store.read();
    if (devices.length === 0) {
        console.log('No light saved yet. Run: smartlife-light setup');
        return;
    }
    for (const d of devices) {
        const where = d.ip ?? dim('ip unknown yet');
        const version = d.version ? `protocol ${d.version}` : '';
        console.log(`  ${bold(d.name)}  ${dim(d.id)}  ${d.productName || d.category || ''}  ${where}  ${version}`);
    }
}

// ---------------------------------------------------------------------------------------------
// status, watch, set
// ---------------------------------------------------------------------------------------------

function pick(devices: StoredDevice[], query?: string): StoredDevice {
    if (devices.length === 0) {
        throw new Error('No light saved yet. Run: smartlife-light setup');
    }
    if (!query) {
        if (devices.length === 1) {
            return devices[0];
        }
        throw new Error(`Which light? ${devices.map((d) => `"${d.name}"`).join(', ')}`);
    }
    const q = query.toLowerCase();
    const hit = devices.find((d) => d.id === query) ?? devices.find((d) => d.name.toLowerCase() === q)
        ?? devices.find((d) => d.name.toLowerCase().includes(q) || d.id.startsWith(query));
    if (!hit) {
        throw new Error(`No saved light matches "${query}". Saved: ${devices.map((d) => `"${d.name}"`).join(', ')}`);
    }
    return hit;
}

async function connect(options: Options, query?: string): Promise<{ device: TuyaDevice; saved: StoredDevice }> {
    const store = new DeviceStore(storagePath(options));
    const saved = pick(store.read().devices, query);

    let found: Broadcast | undefined;
    if (!saved.ip) {
        console.log(`Looking for ${saved.name} on the network…`);
        found = (await discover({ ids: [saved.id], timeoutMs: 10_000 })).get(saved.id);
        if (!found) {
            throw new Error(`${saved.name} was not found on the network. Is it on and on the same Wi-Fi?`);
        }
        store.patch(saved.id, { ip: found.ip, version: found.version });
    }

    const device = new TuyaDevice({
        id: saved.id,
        key: saved.localKey,
        ip: saved.ip ?? found!.ip,
        version: saved.version ?? found?.version,
        log: {
            debug: (m) => options.debug && console.log(dim(m)),
            info: (m) => console.log(m),
            warn: (m) => console.log(yellow(m)),
            error: (m) => console.log(red(m)),
        },
    });

    await new Promise<void>((resolve, reject) => {
        device.once('connected', () => resolve());
        device.on('connect-failed', (error, count) => {
            console.log(yellow(`  could not connect (${error.message})`));
            if (count >= 3) {
                device.stop();
                reject(new Error(`Could not connect to ${saved.name} at ${device.address}. `
                    + 'Is the Smart Life app open on a phone holding the connection?'));
            }
        });
        device.start();
    });
    return { device, saved };
}

function describe(saved: StoredDevice, device: TuyaDevice) {
    console.log(`\n${bold(saved.name)}  ${dim(saved.id)}`);
    console.log(`  address   ${device.address}   protocol ${device.version}`);
    console.log('  data points reported by the light:');
    for (const [dp, value] of Object.entries(device.dps)) {
        const code = saved.dps?.find((d) => String(d.id) === dp)?.code;
        console.log(`    ${dp.padStart(4)}  ${JSON.stringify(value).padEnd(24)} ${code ? dim(code) : ''}`);
    }
    const profile = buildProfile(saved.dps, device.dps);
    if (!profile) {
        console.log(yellow('  This does not look like a light I can drive.'));
        return;
    }
    console.log('  understood as:');
    console.log(`    ${JSON.stringify(profile)}`);
    console.log(`  HomeKit sees: ${JSON.stringify(readState(profile, device.dps))}`);
}

async function status(options: Options, watch: boolean) {
    const { device, saved } = await connect(options, options.positional[1]);
    describe(saved, device);
    if (!watch) {
        device.stop();
        return;
    }
    console.log(`\n${bold('Watching.')} Change something in the Smart Life app or with the wall switch. Ctrl-C to stop.`);
    console.log(dim('Tip: right after each action, type what you did and press Enter (e.g. "stars off"): it is written in the log\n'
        + 'next to the data points that moved, which tells what each data point does.\n'));
    // each typed line becomes a marker in the log
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const label = line.trim();
        if (label) {
            console.log(`${dim(new Date().toLocaleTimeString())}  ${bold(`▶ ${label}`)}`);
        }
    });
    device.on('dps', (changed) => {
        const time = new Date().toLocaleTimeString();
        console.log(`${dim(time)}  ${Object.entries(changed).map(([k, v]) => `${bold(k)} = ${JSON.stringify(v)}`).join('   ')}`);
    });
    device.on('disconnected', () => console.log(yellow('connection lost, reconnecting…')));
    await new Promise(() => undefined);
}

async function set(options: Options) {
    const [, query, ...assignments] = options.positional;
    if (assignments.length === 0) {
        throw new Error('Usage: smartlife-light set <light> <dp>=<value> ...   e.g. set Desk 20=true 22=500');
    }
    const dps: Dps = {};
    for (const assignment of assignments) {
        const [dp, ...rest] = assignment.split('=');
        const raw = rest.join('=');
        if (!/^\d+$/.test(dp) || raw === '') {
            throw new Error(`"${assignment}" is not <dp>=<value>`);
        }
        try {
            dps[dp] = JSON.parse(raw);
        } catch {
            dps[dp] = raw; // a bare word such as colour
        }
    }
    const { device } = await connect(options, query);
    await device.set(dps);
    console.log(green('Done.') + ` Light now reports ${JSON.stringify(device.dps)}`);
    device.stop();
}

// ---------------------------------------------------------------------------------------------

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const command = options.positional[0];
    switch (command) {
        case 'setup': return setup(options);
        case 'scan': return scan(options);
        case 'list': return list(options);
        case 'status': return status(options, false);
        case 'watch': return status(options, true);
        case 'set': return set(options);
        default:
            console.log(HELP);
            if (command && command !== 'help' && command !== '--help') {
                process.exitCode = 1;
            }
    }
}

main().then(() => {
    if (process.argv[2] !== 'watch') {
        process.exit();
    }
}, (error: Error) => {
    console.error(red(error instanceof SharingError ? `Tuya says: ${error.message}` : error.message));
    process.exit(1);
});
