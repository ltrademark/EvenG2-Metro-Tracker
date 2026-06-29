<img width="100" height="100" alt="image" src="https://github.com/user-attachments/assets/9defd0ed-33ed-45ce-a807-ca5aa3fce5c6" />

# MetroTracker

Real-time Washington DC Metro tracker for Even Realities G2 smart glasses. The glasses show a live arrivals board — line, destination, and minutes to arrival — mirroring the departure signs in the stations. The companion phone app adds an interactive map of the whole rail network, station search, and a **Live View** of trains moving across the map in real time. Data comes from the official [WMATA](https://developer.wmata.com) API.

## Glasses display

- **Arrivals board** for the nearest (or a chosen) station — line, car count, destination, and minutes, auto-refreshing every 30 seconds
- **Station list** of your current stop plus nearby stations; tap to view any one's board
- **Switch direction** with a tap; double-tap to return to the list
- **Location indicator** showing whether you're on GPS or a manually-picked station
- Remembers your last station so it loads instantly next launch

## Phone app

- **Dark map** of the full network — color-coded line ribbons and station markers
- **Search** any station with line-aware autocomplete
- **Boarding-times panel** for your current or selected station, with live distance
- **Live View** — hides the panel and animates real-time trains along the lines; tap a train for its destination, car count, and train number; refreshes every 10s with an on-screen countdown
- **Recenter** button and an in-app info/changelog screen

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

> The free WMATA tier allows 10 requests/second and 50,000/day. The glasses board polls every 30s (and backs off to 5-minute intervals when Metro is closed); Live View polls train positions every 10s — both well within limits.

## Running

Start the dev server and simulator in two terminals:

```bash
# Terminal 1
yarn dev

# Terminal 2
yarn simulate
```

The simulator shows both the phone UI (Leaflet map) and the glasses display. In dev mode the app pins to **Metro Center** so you get live data without real GPS.

To test on your actual phone and glasses, run `yarn dev --host 0.0.0.0` and open `http://<your-machine-ip>:5173` via Even Hub's QR (`yarn evenhub qr --url "http://<your-ip>:5173"`), or `yarn build` and deploy `dist/`.

## Project structure

```
src/
├── App.vue              Phone UI — map, boarding panel, search, Live View (Vue Options API)
├── components/
│   ├── StationPanel.vue   Current/Selected station header + boarding-times list
│   ├── TrainList.vue      Arrival rows with line-badge icons
│   ├── SearchBar.vue      Station autocomplete
│   ├── LineIcon.vue       Line-badge SVG
│   └── InfoModal.vue      App info, changelog, and links
├── bridge.ts            SDK orchestrator — wires modules to the Vue app
├── wmata.ts             WMATA client — stations, predictions, live positions, circuit→map model
├── glasses.ts           Glasses display renderer (splash, station list, timetable)
├── location.ts          GPS → nearest station via haversine
├── lineIcons.ts         Shared line → badge-SVG map
├── version.ts           App version / name / description
└── changelog.ts         In-app changelog entries
```

## Scripts

| Command | Description |
|---|---|
| `yarn dev` | Start Vite dev server on `:5173` |
| `yarn simulate` | Launch the Even Hub simulator pointed at the dev server |
| `yarn build` | Production build to `dist/` |
| `yarn preview` | Preview the production build locally |
