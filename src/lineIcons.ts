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
