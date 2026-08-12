<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/3986fad4-3a15-448f-819c-22b89bd18e30" />


---

<div align="center">
  <img width="144" height="144" alt="image" src="/src/assets/app-icon.svg" />
  <h1>MetroTracker</h1>
  <p>Real-time Washington DC Metro tracker for Even Realities G2 smart glasses. The glasses show a live arrivals board carrying line, destination, and minutes to arrival, mirroring the departure signs in the stations. Look up and the board gives way to a track view of where you and the trains around you are along the line. The companion phone app adds an interactive map of the whole rail network, station search, and a <b>Live View</b> of trains moving across the map in real time. Data comes from the official <a href="https://developer.wmata.com" target="_blank">WMATA</a> API.</p>
  <a href="https://hub.evenrealities.com/landing?package_id=com.ltrademark.wmatatracker" target="_blank">
    <picture width="180" height="51">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/076a0ed7-136d-41a4-832e-26f17ee8dc99">
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/76e98b85-722b-4452-8aec-8d7fbfd22915">
      <img alt="Get it on EvenHub" src="https://github.com/user-attachments/assets/76e98b85-722b-4452-8aec-8d7fbfd22915" />
    </picture>
  </a>
</div>

---

## Glasses display

- **Arrivals board** for the nearest (or a chosen) station, listing line, car count, destination, and minutes, auto-refreshing every 30 seconds
- **Station list** of your current stop plus nearby stations; tap to view any one's board. While you're riding, it orders by the line's own sequence in your direction of travel, so the stops ahead of you are the ones you see
- **Track view**, showing where you are along the line and where the trains around you are. It takes the place of the arrivals panel, so the station list beside it never moves while you read it
- **Look up to reveal the track view**, and look back down or straight ahead to return to the timetable exactly as you left it. The motion sensor is only powered while a board is on screen
- **Switch direction** with a tap; double-tap to return to the list
- **Location indicator** showing whether you're on GPS or a manually-picked station, plus an in-transit badge while you're moving
- Remembers your last station so it loads instantly next launch

|    |    |    |
| -- | -- | -- |
| <img width="576" height="288" alt="image" src="https://github.com/user-attachments/assets/cae0bf60-3ce9-4b82-ba73-8f2c93951821" /> | <img width="576" height="288" alt="image" src="https://github.com/user-attachments/assets/b80d2c2d-cf5a-45a5-956b-84248a791012" /> | <img width="576" height="288" alt="image" src="https://github.com/user-attachments/assets/d37c9992-9879-4a55-9b03-d0e100888429" /> |


## Phone app

- **Full** network map with colour-coded line ribbons and station markers
- **Search** any station with line-aware autocomplete
- **Boarding-times panel** for your current or selected station, with live distance
- **Live View** hides the panel and animates real-time trains along the lines; tap a train for its destination, car count, and train number; refreshes every 10s with an on-screen countdown
- **Recenter** button and an in-app info/changelog screen
- Built on the Even Realities light theme, with every colour and radius declared as a token in `src/theme.css`

|    |    |    |
| -- | -- | -- |
| <img width="2880" height="5630" alt="image" src="https://github.com/user-attachments/assets/5507ee40-8409-4f4e-99d8-0c2bd612dde3" /> | <img width="2880" height="5630" alt="image" src="https://github.com/user-attachments/assets/62ff3561-6848-4899-b782-8f1c1fbe0078" /> | <img width="2880" height="5630" alt="image" src="https://github.com/user-attachments/assets/16a8e10a-972f-48fa-ac97-33957e42afc2" /> |




## Prerequisites to build

- [Node.js](https://nodejs.org) 18+
- [Yarn](https://yarnpkg.com) 1.x
- [Even Hub](https://evenrealities.com) installed on your phone and paired with your G2 glasses
- A WMATA API key, free to register at [developer.wmata.com](https://developer.wmata.com)

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

> The free WMATA tier allows 10 requests/second and 50,000/day. The glasses board polls every 30s (and backs off to 5-minute intervals when Metro is closed); Live View polls train positions every 10s, and the track view reuses that same throttled fetch rather than issuing its own. All of it sits well within the limits.

## Running

Start the dev server and simulator in two terminals:

```bash
# Terminal 1
yarn dev

# Terminal 2
yarn simulate
```

The simulator shows both the phone UI (Leaflet map) and the glasses display. In dev mode the app pins to **Metro Center** so you get live data without real GPS.

The simulator implements no motion sensor, so the head tilt cannot be exercised there. Where the app detects that, scrolling up on a timetable stands in for looking up, and scrolling inside the track view nudges your position along the line. Both are development-only and are dead on a real device, where the tilt is the only way in.

To test on your actual phone and glasses, run `yarn dev --host 0.0.0.0` and open `http://<your-machine-ip>:5173` via Even Hub's QR (`yarn evenhub qr --url "http://<your-ip>:5173"`), or `yarn build` and deploy `dist/`.

## Project structure

```
src/
├── App.vue              Phone UI: map, boarding panel, search, Live View (Vue Options API)
├── theme.css            Design tokens: every colour, radius, and scale
├── components/
│   ├── StationPanel.vue   Current/Selected station header + boarding-times list
│   ├── TrainList.vue      Arrival rows with line-badge icons
│   ├── SearchBar.vue      Station autocomplete
│   ├── LineIcon.vue       Line-badge SVG
│   └── InfoModal.vue      App info, changelog, and links
├── bridge.ts            SDK orchestrator, wiring the modules to the Vue app
├── wmata.ts             WMATA client: stations, predictions, live positions, circuit→map model
├── glasses.ts           Glasses display renderer (splash, station list, timetable, track view)
├── live.ts              Track view state: line, orientation, and your position along it
├── tilt.ts              Head-tilt detector driving the IMU, plus its calibration run
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
