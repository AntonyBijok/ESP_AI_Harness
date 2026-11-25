#!/usr/bin/env python3
"""Subscribe to the bench broker and print what the DUT actually publishes.

Why this exists: no MQTT tool in this plugin can *prove delivery*, because delivery
needs a second party listening. The partner firmware publishes on MQTT CONNECT — a
short burst (seq 0,1,2,3) to `testbench/dut/<mac>/hello` — and never again. So a
subscriber started after the board connects sees an empty topic and looks exactly
like a broken broker. Subscribe FIRST, then reboot or re-provision the DUT.

The broker is one mosquitto on the bench, reachable at its LAN address from here and
at 192.168.4.1 from a station on the bench AP. Either address sees the same messages,
which is what makes this check meaningful: it proves the DUT's publish crossed the
radio, the AP, the broker, and back out the wired side.

    pip install paho-mqtt
    python3 tools/mqtt-subscribe.py                        # 60 s, all DUTs
    python3 tools/mqtt-subscribe.py --seconds 120
    python3 tools/mqtt-subscribe.py --topic 'testbench/dut/d0cf13411e0c/hello'

Exits 0 if at least one message arrived, 1 if none did — so it can gate a test.
"""

from __future__ import annotations

import argparse
import sys
import time
import paho.mqtt.client as mqtt

DEFAULT_HOST = "192.168.0.29"
DEFAULT_TOPIC = "testbench/dut/+/hello"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=DEFAULT_HOST, help="bench broker address")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--topic", default=DEFAULT_TOPIC, help="subscription filter")
    parser.add_argument("--seconds", type=float, default=60.0, help="how long to listen")
    args = parser.parse_args()

    received: list[str] = []

    def on_connect(client, userdata, flags, reason_code, properties=None):
        print(f"connected rc={reason_code}; subscribing {args.topic}", flush=True)
        client.subscribe(args.topic, qos=0)

    def on_message(client, userdata, message):
        line = f"{message.topic}  {message.payload.decode('utf-8', 'replace')}"
        received.append(line)
        print(f"  RECEIVED {line}", flush=True)

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    except (AttributeError, TypeError):  # paho-mqtt 1.x
        client = mqtt.Client()
    client.on_connect, client.on_message = on_connect, on_message

    print(f"subscribing to {args.topic} on {args.host}:{args.port} for {args.seconds:g}s", flush=True)
    client.connect(args.host, args.port, keepalive=30)
    client.loop_start()
    deadline = time.time() + args.seconds
    try:
        while time.time() < deadline:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    client.loop_stop()
    client.disconnect()

    if not received:
        print(
            "\nNO MESSAGES. Before concluding the broker is broken: the DUT publishes only on\n"
            "MQTT connect. If it was already connected when this started, nothing will ever\n"
            "arrive. Reboot it (tb_serial_exec command=reboot) or re-provision it and run this again.",
            flush=True,
        )
        return 1
    print(f"\n{len(received)} message(s) delivered.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
