// Single source for the WMATA line badge SVGs (used by LineIcon.vue and the
// live-train map popup).
import Red from './assets/Line_Red.svg'
import Blue from './assets/Line_Blue.svg'
import Orange from './assets/Line_Orange.svg'
import Silver from './assets/Line_Silver.svg'
import Green from './assets/Line_Green.svg'
import Yellow from './assets/Line_Yellow.svg'
import NoPassenger from './assets/Line_No Passenger.svg'

const LINE_ICON: Record<string, string> = {
  RD: Red,
  BL: Blue,
  OR: Orange,
  SV: Silver,
  GR: Green,
  YL: Yellow,
}

// Out-of-service / no-line falls back to the slash glyph.
export function lineIconUrl(line: string): string {
  return LINE_ICON[line?.toUpperCase()] ?? NoPassenger
}

// WMATA's own line colours. These live here rather than in theme.css because
// only JavaScript consumes them, to recolour the train marker SVG and to tint
// the map popup, and a CSS custom property cannot be read from script without
// reaching into computed styles. They are also brand colours, so unlike
// everything in theme.css they are not ours to redesign.
const LINE_COLOR: Record<string, string> = {
  RD: '#E31937',
  BL: '#0076C0',
  OR: '#F7941D',
  SV: '#A1A2A1',
  GR: '#0DA94F',
  YL: '#FFD200',
}

const LINE_COLOR_UNKNOWN = '#888'

// Colour for a line code, falling back to grey for a train reporting no line or
// one we don't know. Callers used to repeat that fallback at each site.
export function lineColor(line: string): string {
  return LINE_COLOR[line?.toUpperCase()] ?? LINE_COLOR_UNKNOWN
}
