// Shown in the info modal (latest entry only). Update the copy on each version
// bump; the version itself is taken from APP_VERSION so the two can never drift,
// which they had, leaving the modal saying 0.6.0 beside a 0.6.1 badge on the map.
//
// User-facing copy only. See changes.md for the full log.
//
// The track strip is advertised here for the first time. It shipped in 0.7.0 but
// with no way to reach it, so it was deliberately left out of that release's list;
// the head tilt now exists, which is what makes it a feature rather than dead code.
//
// The battery line is deliberate too, not filler: 0.6.0 advertised better battery
// life partly by removing the motion sensor, so bringing it back needs to say
// plainly that it is only ever powered while a board is on screen.
import { APP_VERSION } from './version'
export interface ChangelogEntry {
  version: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry = {
  version: APP_VERSION,
  changes: [
    'Look up while a timetable is on screen to see where the trains are on your line',
    'Look back down and the timetable returns exactly as you left it',
    'The motion sensor is only powered while a board is on screen, so the gesture costs almost nothing',
    'The track view sits beside the station list, so the list never moves while you read it',
    'The What\'s New backdrop now matches the rest of the app',
  ],
}
