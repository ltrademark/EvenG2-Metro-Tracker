# Changes

A running log of every change, newest version first. MetroTracker is a real-time
DC Metro (WMATA) tracker for the Even Realities G2 smart glasses, with a companion
phone web-app map.

## v0.6.0

### Glasses UI
- **Station picker redesign.** The landing list now uses the native selection
  cursor (a highlight box that moves as you scroll) to show what you're about to
  select — no more `>`/`-` text prefixes. The `>` marker is now timetable-only,
  where it marks the viewed station and intentionally shifts that row's text for
  distinction. The cursor floats inside the list with comfortable padding.
- **Timetable keeps the selected station visible.** When you select a station
  that's scrolled past the visible area, the timetable's station list windows to
  keep it on screen (as if scrolled down to it) instead of snapping to the top.
- **Full-width divider** under the timetable destination header (meets both panel
  borders).
- **Balanced spacing** above and below the timetable destination header.
- **Lighter periodic refresh.** While on the landing view, the 10s refresh updates
  only the status line in place rather than rebuilding the station list, so the
  selection cursor never jumps (and it's easier on the battery).

### Lifecycle & store compliance
- Added `bridge.shutDownPageContainer(1)` on the top-level back gesture, with
  resource cleanup wired to the `SYSTEM_EXIT` / `ABNORMAL_EXIT` events (fixes the
  EvenHub submission rejection).
- Unsubscribe the `onEvenHubEvent` listener on teardown.
- Declared the `network` permission whitelist in `app.json` (WMATA API +
  CartoDB tile hosts) — required for packaging/review.

### Web-app map
- **Merged duplicate transfer dots.** Dual-code stations (Metro Center, Gallery
  Place, L'Enfant Plaza, Fort Totten) now render as a single dot instead of two
  overlapping ones.
- **Connection station dots.** New SVG icons: a plain dot for normal stops and a
  larger ringed dot for connection stations. Connections are detected from the
  data — dual-platform transfers plus single-platform line-branch junctions
  (Rosslyn, Pentagon, Stadium-Armory, East Falls Church, King St-Old Town).
- **Connection dots centered on the crossing.** Hub dots are placed at the
  least-squares intersection of their lines' offset ribbons, with a bounded
  centroid fallback for shallow branches, so the larger dot sits on the actual
  ribbon crossing at every zoom level.

## v0.5.7
- Gradient background on the boarding panel (#0F0F0F → #272727).
- Row dividers and map-button borders set to #464646 (per Figma).
- Rounded top corners on the boarding panel with a #464646 top border.
- Float the boarding panel over the map, so the map peeks behind its rounded top.
- Align station dots onto their line ribbons.

## v0.5.6
- Removed the unused IMU head-gesture handling (improves battery use on the glasses).
- Added train direction icon assets (`Train_dir_1` / `Train_dir_2`).
- Updated the README for the redesigned app (web redesign, Live View, etc.).

## v0.5.5
- **Live View:** watch real-time trains move across the map.
- Draw the Metro lines on the map as color-coded, side-by-side parallel ribbons.
- Tap a train for a popup with its destination, car count, and train number
  (line-icon SVG in the popup).
- Live positions refresh every 10s with an on-screen "Updating in Ns" countdown.
- Train icons rotated so the arrow leads along travel; heading derived from actual
  movement between polls (not route sequence).
- Spliced in stations missing from WMATA's route data (e.g. Potomac Yard) so both
  the drawn lines and the train positions follow the same path through them.
- Enlarged station dots (8px → 12px) so they read over the route lines.
- 4-state location button on the web app.
- Distance now tracks the station you're viewing, not just your home stop.
- Sync the glasses-selected station to the web app; never display "0.0mi".
- Dropped "WMATA" from the app's name/branding (kept WMATA attribution in the
  permission description and README so users know it's DC-specific).
- Dedupe transfer stations in search; sticky panel header; smaller search chevron.

## v0.5.0
- **Full web-app redesign:** single-column mobile layout with an interactive map
  and a boarding panel, station search with autocomplete, line-icon SVGs, a
  location button, and an info modal (changelog, attribution, "Report a bug").

## v0.4.0
- Redesigned the glasses list and timetable views with hardware-safe text fitting.
- Froze the station-list order across views and switched names to Title Case.
- Splash logo now renders on hardware; CTA reads "Waiting for location"; tapping a
  station shows the manual-pin state and "Auto" re-locks to the GPS-nearest stop.
- Persist the last station for instant load on return; resized the logo to 144px.
- Cleaner splash logo; moved the version label to the top-left (no overflow).
- Removed the vestigial location prompt — start SDK location directly; center the
  map on the persisted station before the first GPS fix.

## v0.3.1
- Dark map theme (CartoDB Dark Matter).
- Dark boarding-panel theme with a #1155ee accent.

## v0.3.0
- Timetable direction-switch row redesign (destination header + `< >` switcher).
- Fixed the hardware tap handling, the mobile bottom-sheet layout/breakpoint, the
  logo on hardware, and map auto-zoom on GPS.

## v0.2.5
- Bumped the app edition to 202606 and assorted `app.json` housekeeping.

## v0.2.0
- Redesigned the glasses UI as a 3-view state machine with icons and reworked
  the input/interaction routing.
- Fixed the WMATA predictions endpoints (GetPrediction/All, filtered by
  LocationCode).
- Pinning a station jumps to its timetable and computes nearby stations from the
  station's coordinates.

## v0.1.0
- Initial implementation of the WMATA Metro Tracker for the Even G2 glasses.
- Switched the toolchain to Yarn; renamed the app to MetroTracker; added the README.
- Gated location start behind a user gesture to fix a silent permission denial in
  the Even Hub WebView.
- Added the CC BY-NC-SA 4.0 license.
