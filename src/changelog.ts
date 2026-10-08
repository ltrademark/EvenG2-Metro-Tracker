// Shown in the info modal (latest entry only). Update the copy on each version
// bump; the version itself is taken from APP_VERSION so the two can never drift,
// which they had, leaving the modal saying 0.6.0 beside a 0.6.1 badge on the map.
//
// User-facing copy only. See changes.md for the full log.
//
// 0.7.2 is a map fix, described the way users saw it: a watermark over the map.
import { APP_VERSION } from './version'
export interface ChangelogEntry {
  version: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry = {
  version: APP_VERSION,
  changes: [
    'Fixed the "API key required" message covering parts of the map',
    'The map now comes from OpenFreeMap and looks the same as before',
  ],
}
