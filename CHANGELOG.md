# Changelog

## 0.2.0

- Extra controls: switches, lights with an intensity and fans (speed) exposed as additional tiles of a lamp, for features that are not plain light. Configurable per light with `extras`.
- Star projectors (Smart Star Projector, Nebula Glow...) are recognised automatically: *Stars* (on/off + intensity), *Nebula* (on/off) and *Rotation* (speed) tiles, and the main tile controls the colour of the nebula.
- `smartlife-light watch` takes labels: type what you just did in the app and press Enter, to tell which data point does what.
- Simpler settings form in the Homebridge UI (no empty light entry, no misplaced "Advanced" block).

## 0.1.0

First release.

- Wi-Fi lights of the Smart Life / Tuya Smart apps in Apple Home: on/off, brightness, white temperature and colour, depending on what the light supports.
- Local control over the LAN with its own implementation of Tuya protocols 3.3, 3.4 and 3.5 (checked against TinyTuya), automatic version detection, heartbeat and reconnection.
- Lights are found by their UDP announcements; the IP address is followed when it changes.
- `smartlife-light setup`: link a Smart Life account by scanning a QR code, save the lights and add the plugin to `config.json`.
- `smartlife-light scan`, `list`, `status`, `watch` and `set` to inspect and troubleshoot a light.
