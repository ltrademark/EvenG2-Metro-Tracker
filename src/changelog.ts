// Shown in the info modal (latest entry only). Update on each version bump.
export interface ChangelogEntry {
  version: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry = {
  version: '0.5.0',
  changes: [
    'Redesigned phone app: single-column map with a live boarding-times panel',
    'Search any station with line-aware autocomplete',
    'Tap a station on the map or in search to view its board',
    'Live GPS location pin with one-tap recenter',
    'Station list now uses the official line badges',
    'Added this app info & changelog screen',
  ],
}
