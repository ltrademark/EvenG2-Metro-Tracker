# Changes

A running log of every change, newest version first. MetroTracker is a real-time
DC Metro (WMATA) tracker for the Even Realities G2 smart glasses, with a companion
phone web-app map.

## v0.7.1

### Glasses UI
- **The live track view is reachable.** Looking up while a timetable is on screen reveals it; returning to level restores the timetable. It shipped in 0.7.0 with both entry points DEV-gated and no gesture to open them, so this is the release that actually makes it a feature.
- **Fixed the track's fading end caps rendering roughly three times too tall.** The art is a 6px bar but an image container is invalid below 20px, and the firmware scales a source smaller than its container. This was invisible in the simulator, which draws images at native size, so it only appeared on real hardware. The files are now padded to exactly the container size, which removes the scaling step rather than trying to predict it. Every other image container was audited against its source; these two were the only mismatch.

### Head tilt
- **Powered only inside a narrow window:** startup succeeded, the app is foregrounded, both the drawn view and the intent are a timetable or the track view, and the board has been touched in the last 90 seconds. The previous IMU controller was deleted in `e075652` for draining the battery, having only ever been stopped from `destroy()`. The sensor is now released synchronously and first on foreground exit, system exit and abnormal exit, none of which released any hardware before.
- **Deliberately not gated on being in transit,** which sounds right and is not: motion decays to stationary after 120s without a GPS fix, and a platform or tunnel is exactly where fixes stop, so that gate would arm the gesture on the street and disarm it where the reveal matters.
- **The gesture must be held,** with separate enter and exit angles and a longer dwell on the way back, so reading an arrival board does not trip it and returning to level is not twitchy. Edges are rate-limited, since each one costs a full page rebuild.
- **Pitch is measured against a resting baseline seeded from a measured constant.** Straight ahead reads -8.5 degrees on real glasses rather than zero, because they sit tilted on the face. Two earlier versions of this were wrong: measuring the absolute angle left only 2 degrees of margin below a held pose, and seeding the baseline from the first sample meant launching while looking down at the phone made "down" the zero, after which no amount of looking up would trigger it.
- **An arm that produces no reports is retried, then reported.** `imuControl` can resolve successfully and still deliver nothing, which was observed across a page reload, and is indistinguishable from broken code from the outside.
- A host that does not implement `imuControl` at all is recognised as such and stops being asked, rather than logging a warning on every view change forever.

### Phone app
- **The What's New backdrop washes toward the page grey** at 70% rather than toward white, matching the design. It is one token with one consumer.

### Internal
- **A DEV-only diagnostics sink.** On real hardware the console lives in the phone's WebView, which needs remote debugging to read and cannot be pasted from, so anything the app learns on-device was effectively unreachable. Diagnostics now POST to the dev server, which prints them and writes them to `dev-logs/`. Both halves are absent from production builds: the endpoint is `apply: 'serve'` and the client side is behind `import.meta.env.DEV`.
- **A DEV-only tilt calibration run,** at `?calibrate=1`. Which axis carries pitch and which sign means up cannot be derived at runtime, and cannot be read off a screen either, since looking at one changes the pitch being measured. The glasses drive the whole capture on a timer and ship the numbers out afterwards. Straight ahead is captured twice as a control: if the two disagree by more than the noise band the glasses shifted during the run and the results say so.
- The measured device facts are recorded in `src/tilt.ts`: it is an accelerometer rather than a rate sensor, units are g, pitch is on x with up positive, and `ImuReportPace.P200` delivers about 5 Hz, so that opaque pacing code is a period in milliseconds.
- The scroll-based stand-in for the tilt is now gated on the IMU being provably absent rather than on `DEV`, since a DEV build is what runs on the glasses when testing off the dev server. It survives for the simulator, which implements no IMU, and is dead on a real device.
- `app.json`'s network permission described the map tiles as dark; they have been light since 0.7.0.

## v0.7.0

### Phone app
- **Redesigned to the Even Realities light theme.** Grey page, white cards, dark ink, and the map on light tiles instead of dark. Colours and geometry were sampled and measured off the mockups rather than estimated, so a card is exactly `#FFFFFF` on `#EEEEEE`, the arrival green is `#11C808`, and the gutters, card heights and badge sizes come from the same source.
- **Search moved into the flow** beneath the host's title bar, and its results now take over the whole area below the field rather than dropping a list over the map. The chevron is gone: tapping the field already opened the list.
- **Arrivals are discrete cards** with gaps, rather than rows in a divided list, and the line badges are smaller to match.
- **The boarding panel is flat.** It used to be a rounded sheet floating over a map that extended behind it; the map no longer underlaps and centring no longer compensates for an underlap that is not there.
- **No drop shadows anywhere.** This is also what made the panel look faintly two-toned: the background was a single flat colour all along, but each arrival card cast a shadow into the gap below it, banding the gutter.
- **Floating map controls** are solid white with a hairline, sharing one corner radius with the search field. The Live View mark uses its own icon.
- **The station name tooltip is themed.** It bound no class, so Leaflet's own stylesheet won and it rendered light-on-white.
- **Fixed the location, help, app and Ltrademark marks vanishing.** All four were white fills, invisible the moment the surfaces behind them turned white. They now declare `fill="currentColor"` and take their colour from CSS, which cannot silently break the way replacing a literal fill did.
- **Fixed the modal version.** It read the changelog's own version string, which had drifted a release behind the app.

### Glasses UI
- **Fixed the display wedging after a refresh.** The render lock was held across unbounded BLE and network awaits and released only in a `finally`, so one call that never settled left it set forever: taps stopped opening the timetable while on-device scrolling kept working, and only restarting the plugin recovered it. Renders are now serialised through a queue that releases on every path, every bridge call is bounded, and a render arriving mid-flight is queued rather than dropped.
- **Upcoming stops while riding.** The station list orders by the line's own sequence in the direction of travel instead of by raw distance, so stops behind you stop appearing simply because they are still close. Falls back to distance whenever the answer is not confident.
- **An in-transit badge** beside the location badge while moving.
- **A live track view**, showing where you are along the line and where the trains around you are, in place of the timetable's arrivals panel so the station list beside it never moves. **Not yet reachable:** the head tilt meant to reveal it is not built, so both entry points are DEV-only and it does not ship accessible.
- Nearby stations no longer list a dual-platform interchange twice, since WMATA records such a station once per platform and both entries sort to the top together.

### Reliability
- WMATA calls are bounded by an abort timeout. `fetch` has no default, so a request made in a tunnel could stay pending indefinitely.
- Train positions are throttled inside the client, so a second consumer costs no extra API calls.
- An arrival time that is not a number no longer renders as a bare unit. WMATA returns it empty near closing.
- Image pushes to the glasses check their result, which was previously discarded, so an asset the firmware rejects says so instead of leaving a blank container.

### Internal
- Every colour and radius lives in `src/theme.css`. 38 literals across the components and in JavaScript became tokens, and the six near-identical border greys became three named weights.
- Spacing, type and weight scales are declared for layout to use. Not yet adopted: 151 raw px literals remain in the components.
- WMATA line colours moved behind a `lineColor()` helper, so the grey fallback is no longer repeated at each call site.
- The drawn line path and its station codes are built from one deduplicated anchor list, so an index into one can no longer disagree with a position on the other.

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
