<img width="100" height="100" alt="image" src="https://github.com/user-attachments/assets/9defd0ed-33ed-45ce-a807-ca5aa3fce5c6" />

# MetroTracker

Real-time DC Metro arrival board for Even Realities G2 smart glasses. The glasses display mirrors the departure signs found at Metro stations — line, destination, and minutes until arrival. The phone shows an interactive map with your live location and color-coded station markers.

## How it works

- **Glasses display** — up to 5 upcoming trains for the nearest station, auto-refreshing every 30 seconds
- **Phone map** — OpenStreetMap with Metro station markers; tap any station to pin it manually
- **Auto-location** — uses phone GPS to detect the nearest station; falls back gracefully if GPS is unavailable
- **IMU gestures** — head-up gesture triggers a manual refresh on hardware (not available in simulator)

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Yarn](https://yarnpkg.com) 1.x
- [Even Hub](https://evenrealities.com) installed on your phone and paired with your G2 glasses
- A WMATA API key — register free at [developer.wmata.com](https://developer.wmata.com)

## Setup

```bash
git clone https://github.com/ltrademark/EvenG2-Metro-Tracker
cd EvenG2-Metro-Tracker
yarn install
```

Copy the env template and add your WMATA key:

```bash
cp .env.example .env
# edit .env and set WMATA_API_KEY=your_key_here
```

> The free tier supports 10 requests/second and 50,000 requests/day. MetroTracker polls at 30-second intervals (well within limits) and backs off to 5-minute intervals automatically when the Metro is closed.

## Running

Start the dev server and simulator in two separate terminals:

```bash
# Terminal 1
yarn dev

# Terminal 2
yarn simulate
```

The simulator opens a window showing both the phone UI (Leaflet map) and the glasses display. In dev mode the app automatically pins to **Metro Center** so you get live train data without needing real GPS.

To test on your actual phone and glasses, open `http://<your-machine-ip>:5173` in Even Hub's browser, or use `yarn build` and deploy the `dist/` folder.

## Project structure

```
src/
├── App.vue                  Phone UI — Leaflet map + sidebar (Vue Options API)
├── components/
│   ├── StationHeader.vue    Station name and pin/auto toggle
│   └── TrainList.vue        Color-coded arrival rows
├── bridge.ts                SDK orchestrator — wires all modules to Vue
├── wmata.ts                 WMATA API client (fetch, cache, rate guard)
├── glasses.ts               Glasses display renderer
├── location.ts              GPS → nearest station via haversine
└── imu.ts                   Head-gesture detection from IMU samples
```

## Scripts

| Command | Description |
|---|---|
| `yarn dev` | Start Vite dev server on `:5173` |
| `yarn simulate` | Launch Even Hub simulator pointed at the dev server |
| `yarn build` | Production build to `dist/` |
| `yarn preview` | Preview the production build locally |
