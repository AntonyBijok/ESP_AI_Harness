---
name: testbench-ble
description: Use this skill whenever the user needs to interact with BLE peripherals through the testbench — scanning for devices, connecting by address, writing to GATT characteristics, or checking connection status. The Pi acts as a BLE-to-HTTP bridge using bleak. Also use when sending keystrokes to BLE HID devices, triggering OTA via BLE commands, or debugging BLE connectivity. Triggers on "BLE", "bluetooth", "GATT", "NUS", "Nordic UART", "BLE scan", "BLE write", "BLE connect".
---

# ESP32 Bluetooth LE Proxy

Base URL: `$TESTBENCH_URL` — see Step 0

## Step 0: The bench in this harness

Nothing here writes a bench address down, and in this harness you do not need one:
the preset's `baseUrl` names it and the `tb_*` tools already carry it. No environment
variable, no discovery, no mDNS — a container cannot resolve mDNS anyway, which is
why `$BENCH` was never usable.

| You want | Tool |
|---|---|
| is it up, which slots, what it lacks | `tb_status` |
| talk to a board | `tb_serial_exec`, `tb_serial_output`, `tb_serial_monitor` |
| image a board, identify it | `tb_flash`, `tb_chip_info` |
| the full contract for any endpoint | `tb_endpoints` then `tb_endpoints id=<id>` |
| everything else (BLE, siggen, port scan, TLS) | `tb_call endpoint=<id> params={…}` |

**The `curl` commands below are the wire protocol underneath those tools.** They are
kept because the exact field names and the `ok` semantics are this skill's subject:
read them as the contract. Prefer the tool; reach for the `curl` when a tool
misbehaves, when you are debugging at the HTTP layer, or when you need a field the
tool does not surface. `TESTBENCH_URL` in those commands is the preset's `baseUrl` —
`tb_status` prints it.

If you ever do need to find a bench from scratch (a new network, a moved Pi),
`skills/esp-idf-handling/discover-testbench.py --url --name <hostname>` answers over
UDP 5888 and refuses to guess when two benches reply.

## Endpoints

Request and response shapes: [FSD Appendix D.5](../../../docs/Harness-FSD.md#d5-ble-proxy).

**One BLE connection at a time** — connect to a second peripheral without
disconnecting the first and the call fails rather than switching.

## Examples

```bash
# Scan for BLE devices (5s timeout)
curl -X POST $TESTBENCH_URL/api/ble/scan \
  -H 'Content-Type: application/json' \
  -d '{"timeout": 5}'

# Scan with name filter
curl -X POST $TESTBENCH_URL/api/ble/scan \
  -H 'Content-Type: application/json' \
  -d '{"timeout": 5, "name_filter": "<device-name>"}'

# Connect by MAC address
curl -X POST $TESTBENCH_URL/api/ble/connect \
  -H 'Content-Type: application/json' \
  -d '{"address": "AA:BB:CC:DD:EE:FF"}'

# Write hex data to a GATT characteristic
curl -X POST $TESTBENCH_URL/api/ble/write \
  -H 'Content-Type: application/json' \
  -d '{"characteristic": "6e400002-b5a3-f393-e0a9-e50e24dcca9e", "data": "48656c6c6f", "response": true}'

# Check connection status
curl $TESTBENCH_URL/api/ble/status

# Disconnect
curl -X POST $TESTBENCH_URL/api/ble/disconnect
```

## Nordic UART Service (NUS) UUIDs

| UUID | Role |
|------|------|
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | NUS Service |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | RX Characteristic (write to this) |
| `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | TX Characteristic (notifications from device) |

## Common Workflows

1. **Send a command via NUS:**
   - `POST /api/ble/scan` with `name_filter` to find device
   - `POST /api/ble/connect` with the MAC address from scan results
   - `POST /api/ble/write` with NUS RX UUID and hex-encoded command
   - `POST /api/ble/disconnect` when done

2. **Check if device is advertising:**
   - `POST /api/ble/scan` with short timeout and name filter
   - Check `devices` array in response

3. **Send binary command protocol:**
   - Connect to device
   - Encode command bytes as hex (e.g., `0x02` + "Hello" = `0248656c6c6f`)
   - Write to NUS RX characteristic
   - Monitor device response via serial or UDP logs (see testbench-logging)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "BLE not available" | `bleak` not installed on testbench Pi |
| Scan returns empty | Increase timeout; check device is advertising |
| Connect fails (409) | Already connected — disconnect first |
| Write fails "invalid hex data" | Data must be hex string (e.g., `"48656c6c6f"` for "Hello") |
| Device not found by name | Check exact advertised name; BLE names are case-sensitive |
