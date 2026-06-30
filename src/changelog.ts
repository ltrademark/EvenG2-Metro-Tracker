// Shown in the info modal (latest entry only). Update on each version bump.
export interface ChangelogEntry {
  version: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry = {
  version: '0.6.0',
  changes: [
    'Clearer station picker on the glasses — a highlight cursor shows the row you’re about to select',
    'Map: transfer stations now show as a single connection dot instead of overlapping duplicates',
    'Cleaner timetable header — full-width divider and balanced spacing',
    'Live View: watch trains move across the map in real time',
    'Metro lines drawn on the map — color-coded and side-by-side',
    'Tap a train to see its destination, car count, and train number',
    'Live positions refresh every 10s with an on-screen countdown',
    'Distance now tracks the station you’re viewing, not just your home stop',
    'Improved battery use on the glasses',
  ],
}
