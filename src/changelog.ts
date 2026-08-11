// Shown in the info modal (latest entry only). Update the copy on each version
// bump; the version itself is taken from APP_VERSION so the two can never drift,
// which they had, leaving the modal saying 0.6.0 beside a 0.6.1 badge on the map.
//
// User-facing copy only. The glasses track strip landed in this release but has no
// way to reach it yet (the head tilt that reveals it is not built), so it is
// deliberately absent from this list rather than advertised as available. See
// changes.md for the full log, which does cover it.
import { APP_VERSION } from './version'
export interface ChangelogEntry {
  version: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry = {
  version: APP_VERSION,
  changes: [
    'The phone app has a new look, matching the Even Realities app',
    'Searching now fills the screen instead of dropping a list over the map',
    'Each arrival is its own card, easier to read at a glance',
    'Fixed the glasses locking up after a refresh, where taps stopped opening timetables until you restarted the app',
    'While you are riding, the glasses list the stops ahead of you in the order you will reach them',
    'A badge on the glasses shows when you are moving',
    'Nearby stations no longer list a transfer station twice',
    'Arrival times no longer come up blank near closing',
    'Metro requests give up rather than hanging when you lose signal in a tunnel',
  ],
}
