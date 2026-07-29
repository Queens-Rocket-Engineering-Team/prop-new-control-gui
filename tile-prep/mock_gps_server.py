"""Mock GPS telemetry server: replays a simulated flight over the *real*
display-telemetry websocket path, so the actual Tauri app (with offline tiles)
can be driven end-to-end with no server or GPS hardware.

Usage:
    uv run mock_gps_server.py [--lat 43.27] [--lon -79.925] [--hz 4]

Then in the GUI set Server IP = localhost. Only /ws/telemetry/display is
served; the state/log sockets will just cycle reconnects, which the GUI
already tolerates.
"""

import argparse
import asyncio
import json
import math
import random

try:
    import websockets
except ImportError:
    raise SystemExit("websockets not installed — run: uv sync (it's in the dev group)")

AZIMUTH_RAD = math.radians(60)


class FlightSim:
    """Pad hold -> boost -> coast -> drogue -> main -> landed."""

    def __init__(self, pad_lat: float, pad_lon: float):
        self.pad_lat, self.pad_lon = pad_lat, pad_lon
        self.t = 0.0
        self.phase = "pad"
        self.alt = 0.0
        self.vv = 0.0
        self.downrange = 0.0
        self.crosswind = 0.0

    def step(self, dt: float):
        self.t += dt
        if self.phase == "pad":
            if self.t > 10:
                self.phase = "boost"
        elif self.phase == "boost":
            self.vv = min(self.vv + 100 * dt, 500)
            self.alt += self.vv * dt
            self.downrange += self.vv * 0.06 * dt
            if self.t > 18:
                self.phase = "coast"
        elif self.phase == "coast":
            self.vv -= 60 * dt
            self.alt += self.vv * dt
            self.downrange += max(self.vv, 0) * 0.06 * dt
            if self.vv <= 0:
                self.phase = "drogue"
        elif self.phase == "drogue":
            self.vv = -25
            self.alt += self.vv * dt
            self.crosswind += 15 * dt
            if self.alt <= 300:
                self.phase = "main"
        elif self.phase == "main":
            self.vv = -6
            self.alt += self.vv * dt
            self.crosswind += 4 * dt
            if self.alt <= 0:
                self.alt = 0.0
                self.phase = "landed"

    def fix(self):
        noise = lambda: (random.random() - 0.5) * 1.0  # ±0.5 m
        north = (self.downrange + noise()) * math.cos(AZIMUTH_RAD)
        east = (self.downrange + noise()) * math.sin(AZIMUTH_RAD) + self.crosswind
        lat = self.pad_lat + north / 111320
        lon = self.pad_lon + east / (111320 * math.cos(math.radians(self.pad_lat)))
        return lat, lon, self.alt


def batch(sim: FlightSim) -> str:
    lat, lon, alt = sim.fix()

    def reading(name, unit, value):
        return {
            "sensor_name": name,
            "unit": unit,
            "sensor_type": "rocket_position",
            "points": [{"t": sim.t, "v": value}],
        }

    return json.dumps({
        "type": "telemetry.display_batch",
        "readings": [
            reading("Lat", "deg", lat),
            reading("Lon", "deg", lon),
            reading("Alt", "m", round(alt)),
            reading("Sats", "", 12),
        ],
    })


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lat", type=float, default=43.27, help="pad latitude")
    ap.add_argument("--lon", type=float, default=-79.925, help="pad longitude")
    ap.add_argument("--hz", type=float, default=4.0, help="fix rate")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    async def handler(ws):
        path = ws.request.path
        if path != "/ws/telemetry/display":
            await asyncio.Future()  # accept and stay silent (state/log sockets)
            return
        print(f"display client connected, replaying flight from ({args.lat}, {args.lon})")
        sim = FlightSim(args.lat, args.lon)
        dt = 1.0 / args.hz
        try:
            while True:
                sim.step(dt)
                await ws.send(batch(sim))
                await asyncio.sleep(dt)
        except websockets.ConnectionClosed:
            print("display client disconnected")

    async with websockets.serve(handler, "127.0.0.1", args.port):
        print(f"mock GPS server on ws://127.0.0.1:{args.port}/ws/telemetry/display — Ctrl+C to stop")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
