<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# Homebridge Smart Life Light

[![npm](https://img.shields.io/npm/v/homebridge-smartlife-light.svg)](https://www.npmjs.com/package/homebridge-smartlife-light)

Adds Wi-Fi lights controlled by the **Smart Life** (or Tuya Smart) app to Apple Home.

- **One-minute setup**: enter your Smart Life user code, scan a QR code, done. No developer account, no keys to copy by hand.
- **Local control**: once set up, the light is driven over your own network (instant, works without internet). The Tuya cloud is only used during the setup.
- **Everything the light can do**: on/off, brightness, white temperature, colour. What your light does not have is not shown.
- **Finds your lights by itself**, even when the router gives them a new IP address.

## Install

```
npm install -g homebridge-smartlife-light
```

or search for **Homebridge Smart Life Light** in the Homebridge UI.

## Set up (once)

Open a terminal **on the machine that runs Homebridge** (in the Homebridge UI: the **Terminal** tab) and run:

```
smartlife-light setup
```

1. Open the Smart Life app, tap **Me**, the gear icon, **Account and Security**, and note your **User Code**.
2. Type it in the terminal. A QR code appears.
3. In the app, tap the scan icon (top left of **Home**) and scan it, then approve.

The command saves your lights, offers to add the plugin to `config.json` for you (it makes a backup first), and logs out of Tuya. Restart Homebridge: your lights appear in the Home app.

If Homebridge runs on another machine, run the setup anywhere, then copy `~/.smartlife-light/smartlife-light.json` into the Homebridge storage folder (next to `config.json`). The setup does not need to reach the light, only the internet.

The minimal configuration is:

```json
{
    "platform": "SmartLifeLight",
    "name": "Smart Life Light"
}
```

## Configuration (optional)

Everything below is optional. Each entry of `devices` is matched to a light by its `id` (see `smartlife-light list`).

```json
{
    "platform": "SmartLifeLight",
    "name": "Smart Life Light",
    "devices": [
        { "id": "bf0123456789abcdef01xy", "name": "Desk lamp", "ip": "192.168.1.50" }
    ]
}
```

| Parameter    | Type    | Default   | Note                                                                                   |
|--------------|---------|-----------|----------------------------------------------------------------------------------------|
| `id`         | String  |           | mandatory, the device id                                                               |
| `name`       | String  | app name  | name in HomeKit                                                                        |
| `ip`         | String  | automatic | only if the light cannot be found by itself                                            |
| `key`        | String  |           | local key, only to add a light by hand without running the setup (16 characters)       |
| `version`    | String  | automatic | `3.3`, `3.4` or `3.5`, only if the automatic detection fails                           |
| `minKelvin`  | Integer | 2700      | warmest white of the lamp, adjusts the HomeKit colour temperature slider               |
| `maxKelvin`  | Integer | 6500      | coolest white of the lamp                                                              |
| `exclude`    | Boolean | false     | hide this light from HomeKit                                                           |

## Troubleshooting

The `smartlife-light` command doubles as an inspection tool:

| Command                         | What it does                                                                        |
|---------------------------------|-------------------------------------------------------------------------------------|
| `smartlife-light scan`          | lists the Tuya devices found on the network (id, IP, protocol version)             |
| `smartlife-light list`          | lists the saved lights                                                              |
| `smartlife-light status <light>`| connects and prints the light's data points and how the plugin understands them    |
| `smartlife-light watch <light>` | same, then prints every change live: change something in the Smart Life app        |
| `smartlife-light set <light> 20=true 22=500` | writes data points                                                    |

**"Not found on the network"**: Homebridge and the light must be on the same network (guest networks, VLANs and some mesh "AP isolation" settings block the broadcasts the plugin listens to). Setting `ip` in the configuration works around it.

**"Cannot reach the light"**: a Tuya light accepts a very small number of local connections. Close the Smart Life app on phones that are on the same Wi-Fi, and make sure no other Homebridge/Home Assistant instance talks to the same light.

**The setup says the QR code is invalid**: run it again with `--scheme smartlife`.

**Colours or brightness look wrong**: run `smartlife-light watch <light>`, change the value in the Smart Life app and open an issue with the output. The mapping between Tuya data points and HomeKit is in [`src/tuya/light.ts`](src/tuya/light.ts).

## How it works

Tuya lights speak a local protocol over TCP port 6668, encrypted with a per-device *local key*. The plugin implements protocols 3.3, 3.4 and 3.5 itself (no dependency on a third-party Tuya library) and finds lights through the UDP announcements they broadcast.

The local key is only known to the Tuya cloud. The setup reads it through the same "sign in by QR code" mechanism that other apps use to access a Smart Life account (Tuya's device-sharing API), keeps the keys of your **lights only** in `smartlife-light.json` (readable by its owner only), and then closes the session.

The protocol code is verified byte-for-byte against [TinyTuya](https://github.com/jasonacox/tinytuya) (see `test/fixtures/generate.py`), and the cloud request signing against Tuya's [device-sharing SDK](https://github.com/tuya/tuya-device-sharing-sdk).

> The QR login uses the client id that Tuya registered for Home Assistant's official integration. Tuya does not offer a way to register one for a plugin like this without a developer agreement, so this may stop working if Tuya restricts it. Controlling a light you already know the local key of (the `key` option) never depends on the cloud.

## Development

```
npm install
npm test           # protocol, cloud, light mapping and HomeKit tests (no hardware needed)
npm run lint
npm run watch      # builds, links the plugin and starts Homebridge in debug mode
```

To regenerate the protocol fixtures with TinyTuya as the reference implementation:

```
python3 -m venv .venv && .venv/bin/pip install tinytuya
.venv/bin/python -I test/fixtures/generate.py > test/fixtures/frames.json
```

## License

Apache-2.0. Not affiliated with Tuya or Smart Life.
