# homebridge-airtouch2plus

A [Homebridge](https://homebridge.io) plugin for the **Polyaire AirTouch 2+** ducted air conditioning controller.

This is a fresh implementation targeting the current AirTouch 2+ firmware, which exposes its local API on **TCP port 9200**. The wire protocol (message framing, CRC-16/MODBUS, AC/zone control and status messages) was re-implemented in TypeScript and verified byte-for-byte against the maintained [`nathanvdh/airtouch2-python`](https://github.com/nathanvdh/airtouch2-python) library used by the Home Assistant integration.

## Features

- Each AC unit is exposed as a **HeaterCooler**:
  - Power on/off
  - Mode: Auto / Heat / Cool (restricted to the modes your unit reports as supported)
  - Target temperature (setpoint), with min/max pulled from the unit's ability message
  - Current temperature
  - Fan speed via rotation speed, mapped to the discrete AirTouch speeds the unit supports
- Each zone (group) is exposed as a **Fan**:
  - On/off
  - Damper position via rotation speed (0% turns the zone off)
  - Zone names are read from the console when available
- Automatic reconnection with exponential backoff
- Local push updates plus periodic polling

## Requirements

- Homebridge v1.6+ (or v2 beta)
- Node.js 18+
- An AirTouch 2+ console reachable on your LAN (port 9200)

A static DHCP reservation for the console is strongly recommended so its IP doesn't change.

## Installation

```bash
npm install -g homebridge-airtouch2plus
```

Or search for **AirTouch 2+** in the Homebridge UI plugin screen.

## Configuration

Via the Homebridge UI (recommended), or add a platform block to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AirTouch2Plus",
      "name": "AirTouch 2+",
      "host": "192.168.1.50",
      "port": 9200,
      "exposeZones": true,
      "pollIntervalSeconds": 60,
      "minSetpointStep": 0.1
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `host` | — | **Required.** IP address of the AirTouch 2+ console. |
| `port` | `9200` | API port. Leave as-is for AirTouch 2+ firmware. |
| `exposeZones` | `true` | Expose each zone as a fan with damper control. |
| `pollIntervalSeconds` | `60` | State refresh interval (minimum 15). |
| `minSetpointStep` | `0.1` | Setpoint increment. |

## How it maps to HomeKit

**AC → HeaterCooler.** AirTouch has more modes than HomeKit's HeaterCooler. Heat, Cool and Auto map directly. Dry and Fan modes don't have a HeaterCooler equivalent — if the unit is in one of those, the accessory shows as "idle" while remaining powered, and switching the HomeKit target state moves it back into Heat/Cool/Auto. Setpoint bounds and the list of selectable modes come from each AC's ability message, so you'll only see modes your system actually supports.

**Zone → Fan.** A zone's damper percentage is the fan's rotation speed. Setting speed to 0% turns the zone off; any non-zero speed turns it on and sets the damper. Zones without an ITC temperature sensor are damper-percentage controlled, which is exactly this behaviour.

**Fan speed → separate Fan tile.** The AC's fan speed is exposed as its own Fan accessory (e.g. "Daikin Fan Speed"). This exists because the Apple Home app does not render the fan-speed slider on a HeaterCooler tile — the control is present in the HomeKit data (and visible in apps like Eve), but Apple's UI hides it. The separate tile works around that: the slider snaps to the unit's supported speeds (e.g. Low/Med/High), and turning the tile off selects AUTO fan speed. It controls the same underlying AC fan speed, so it stays in sync with the AC. Disable it with `"exposeFanSpeed": false` if you use a third-party app that already shows the slider.

**Fan-only / Dry mode → separate tiles.** HeaterCooler has no FAN or DRY target state (only Heat/Cool/Auto), so separate tiles switch the AC into those modes: "Fan Only" for air circulation with no heating/cooling (handy overnight), and "Dry" for dehumidify. Turning a tile on sets that mode; turning it off turns the AC off. Disable with `"exposeFanMode": false` / `"exposeDryMode": false`.

## Notes and limitations

- Auto mode reports as "idle" for current state because the protocol status frame doesn't distinguish whether the unit is actively heating or cooling in auto. Target state and setpoint still work.
- Turbo / spill / bypass / timer flags are read from status but not surfaced as separate HomeKit controls in this version.
- The plugin only reads the first AC ability record per response, matching the reference library's behaviour.
- Some firmware (e.g. certain Daikin setups) reports a placeholder setpoint range like `16-16` in the ability message, with the real range held only in the console's preferences. The plugin detects an unusable range and falls back to a safe default; set `setpointMin`/`setpointMax` in config to match your controller's actual range.
- Some consoles periodically broadcast control/status subtypes (e.g. `0x2b`) that are not documented and are not decoded by this plugin or the reference library. These are harmless and safely ignored; the plugin logs each distinct one once at debug level.
- In FAN mode the unit reports no temperature (all-zero bytes, which decode to the protocol minimum). The plugin ignores that sentinel and holds the last real reading, so the tile doesn't show a spurious value. The AirTouch regulates heating/cooling from its own built-in sensor; to drive it from a different room's temperature, use a HomeKit automation from your own sensor to adjust the setpoint or zones.

## Connection stability

The plugin uses aggressive TCP keepalive plus an application-level heartbeat (every 30s) and a staleness check (reconnects if no data is received for 90s), which keeps the link to the console healthy and recovers automatically from drops.

## Protocol verification

The protocol layer under `src/protocol` has a verification harness (`npm run verify`) that generates control/request/status bytes and compares them against reference bytes produced by `airtouch2-python`, including CRCs. All encode and decode cases match exactly.

## Credits

Plugin developed and maintained by **[@dabs79](https://github.com/dabs79)**.

Protocol reverse-engineering and the reference implementation are the work of **[@nathanvdh](https://github.com/nathanvdh)** ([`airtouch2-python`](https://github.com/nathanvdh/airtouch2-python) and the Home Assistant integrations). This plugin is an independent port of that protocol to a Homebridge platform.

## License

MIT
