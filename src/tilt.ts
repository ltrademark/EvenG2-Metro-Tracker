import { ImuReportPace } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Head-tilt gesture: look up to reveal the live strip, return to level to dismiss.
//
// Named for the gesture rather than the sensor, matching location.ts, because the
// rest of the app cares about "the rider looked up", not about which axis of which
// chip reported it.
//
// A previous ImuController was deleted in e075652 for draining the battery: it was
// only ever stopped from destroy(), so the sensor stayed powered for the whole
// session. That is the defect this file is shaped around. The arming policy lives
// in bridge.ts (it needs the drawn view and the foreground state), but everything
// that makes arming *safe* lives here: one owner for the hardware, a latest-wins
// drain so a rapid arm/disarm cannot settle on powered, and a synchronous release
// for teardown paths that may not get to finish.

export interface ImuSample {
  x?: number
  y?: number
  z?: number
}

// ── Measured on a real G2, not assumed ──────────────────────────────────────
//
// The SDK types the payload as three optional unitless doubles (IMU_Report_Data)
// with no documented axis order, units, or sensor type, and describes
// ImuReportPace as an opaque protocol code that is neither Hz nor milliseconds.
// All of that was settled by a calibration run rather than guessed:
//
//   level   x=-0.147 y=-0.102 z=+0.982  |v|=0.998
//   up      x=+0.310 y=-0.271 z=+0.921  |v|=1.008
//   down    x=-0.483 y=+0.032 z=+0.865  |v|=0.991
//
//   - It is an accelerometer, not a rate sensor. |v| stays at 1.00 in every pose
//     and a held pose holds its value instead of decaying toward zero. That is
//     what makes a pose threshold viable at all; a gyroscope would have forced
//     the press-to-reveal fallback.
//   - Units are g, since |v| is 0.998 at rest. Divided out regardless.
//   - x carries pitch: it travels 0.793 between up and down and reverses sign,
//     against 0.302 for y (cross-coupling from slight head roll) and 0.179 for z,
//     which does not reverse at all. Up is positive.
//   - ImuReportPace.P200 delivers ~5 Hz, so the code is a period in ms. Nothing
//     depends on that: every filter constant is a time constant applied against
//     measured arrival gaps, so the gesture feels the same at any pacing.
//
// Straight ahead is NOT zero on this axis: -0.147 is -8.5 degrees, because the
// glasses sit tilted on the face. That is why pitch is measured against a learned
// resting baseline below rather than against the raw axis value. Measuring the
// absolute angle instead put the enter threshold within 2 degrees of the held
// pose, when the intent was to sit 40% below it.
const PITCH_AXIS: keyof ImuSample = 'x'
const PITCH_SIGN = 1

// Enter/exit pair rather than one cutoff, the same reasoning as location.ts's
// motion thresholds: a single threshold makes the state flap while the head sits
// near the boundary, which here would mean the view flickering in and out.
//
// Both are degrees above resting, derived from a measured 27.2 degree look-up:
// enter at 60% of it, exit at 30%. Looking down measures -19.7, so the dismissed
// direction stays far from the enter threshold.
const ENTER_DEG = 16
const EXIT_DEG = 8

// The tilt has to be *held*. Scanning an arrival board sweeps the head through
// plenty of angles, while a deliberate reveal is a sustained pose, and dwell is
// the only thing that separates the two. Level uses the longer dwell so entering
// feels responsive while exiting is not twitchy.
const ENTER_DWELL_MS = 350
const LEVEL_DWELL_MS = 650

// Floor on how often the gesture can redraw, whatever the head does. The view it
// toggles costs a full rebuild, so without this a head bobbing near the threshold
// could queue renders faster than they drain.
const COOLDOWN_MS = 1200

// Where the pitch axis sits when the rider is looking straight ahead, as a
// fraction of gravity, measured on a real device (see the pose table above). Used
// as the starting baseline instead of whatever the first sample happens to be.
//
// Seeding from the first sample was wrong in a way that only showed on hardware:
// the sensor arms when a timetable is drawn, and if the rider was looking down at
// the phone at that moment, "down" became the zero. Looking up then measured near
// zero, never reached the enter threshold, and no amount of exaggerating helped,
// because the reference had moved with the head. A measured constant is right for
// this device and at worst a few degrees off for another face, which the 16 degree
// threshold absorbs.
const REST_AXIS_FRACTION = -0.147

// Time constants, not sample counts. REST is slow because it should track how the
// glasses sit on this face and nothing faster; PITCH is fast enough to keep the
// gesture feeling immediate while still rejecting single bad samples.
const REST_TAU_MS = 4000
const PITCH_TAU_MS = 150

// Gaps longer than this mean reports stopped and resumed (radio hiccup, pacing
// change) rather than a slow stream, so the filters step instead of integrating a
// huge dt in one go.
const MAX_GAP_MS = 1000

// Below this the vector carries no direction to speak of and asin would amplify
// noise into large fake angles.
const MIN_MAGNITUDE = 1e-6

// After this many consecutive imuControl failures the sensor is treated as absent
// and no further attempts are made. Not every host implements the method: the
// simulator rejects it outright as an unknown variant, and without this the policy
// would retry on every view change and log a warning every 30s forever. A few
// retries first, because a genuine transient (bridge busy, glasses reconnecting)
// should not permanently disable the gesture.
const MAX_CONTROL_FAILURES = 3

// imuControl can resolve successfully and still produce no reports. It was
// observed on a page reload: the outgoing page's release races the new page's
// enable, and the sensor ends up off while the app believes it is on, which is
// indistinguishable from the gesture being broken. So an arm that produces no
// samples is retried rather than trusted. Generous relative to the measured 5 Hz,
// so a slow first report is never mistaken for a dead sensor.
const SAMPLE_WATCHDOG_MS = 3000
const MAX_REARMS = 2

// Backoff between imuControl attempts after a rejection. Without it the retries
// only happened when the arming policy next changed, so a genuine transient took
// up to a refresh interval to recover, and a host that does not implement the
// method took three view changes to be recognised as such.
const CONTROL_RETRY_MS = 500

// Weight for one EMA step given the gap since the last sample. dt of 0 leaves the
// value untouched; a gap of several tau converges to the new reading.
function emaAlpha(dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return 0
  return 1 - Math.exp(-dtMs / tauMs)
}

function axisOf(sample: ImuSample, axis: keyof ImuSample): number {
  return sample[axis] ?? 0
}

export type TiltState = 'level' | 'up'

export interface TiltDebug {
  armed: boolean
  unavailable: boolean
  state: TiltState
  pitchDeg: number
  restMag: number
  restAxis: number
  last: ImuSample
}

export class TiltDetector {
  private _bridge: EvenAppBridge
  private _onReveal: () => void
  private _onDismiss: () => void

  // Desired vs applied, because imuControl is async and the arming policy can
  // change several times while one call is in flight.
  private _desiredArmed = false
  private _appliedArmed = false
  private _draining = false
  private _failures = 0
  private _unavailable = false
  private _watchdog: ReturnType<typeof setTimeout> | null = null
  private _retry: ReturnType<typeof setTimeout> | null = null
  private _rearms = 0
  private _sawSample = false

  private _state: TiltState = 'level'
  private _candidate: TiltState = 'level'
  private _candidateSince = 0
  private _lastEdgeAt = 0
  private _lastSampleAt = 0

  // How the glasses sit on this face when the rider is looking straight ahead:
  // the magnitude divides the units out, the axis value is the zero that pitch is
  // measured from. Both are learned, because neither is a constant of the hardware.
  private _restMag = 0
  private _restAxis = 0
  private _haveRest = false
  private _pitchDeg = 0
  private _last: ImuSample = {}

  constructor(bridge: EvenAppBridge, onReveal: () => void, onDismiss: () => void) {
    this._bridge = bridge
    this._onReveal = onReveal
    this._onDismiss = onDismiss
  }

  get armed(): boolean {
    return this._appliedArmed || this._desiredArmed
  }

  // True once the host has proved it does not implement imuControl, which is how
  // the simulator behaves. Callers use it to decide whether a fallback affordance
  // is needed at all, rather than shipping one everywhere just in case.
  get unavailable(): boolean {
    return this._unavailable
  }

  get debug(): TiltDebug {
    return {
      armed: this._appliedArmed,
      unavailable: this._unavailable,
      state: this._state,
      pitchDeg: this._pitchDeg,
      restMag: this._restMag,
      restAxis: this._restAxis,
      last: this._last,
    }
  }

  // The single entry point for the arming policy. Safe to call as often as the
  // policy is re-evaluated: it is idempotent, and the drain collapses bursts.
  setArmed(desired: boolean): void {
    if (desired === this._desiredArmed) {
      void this._drain()
      return
    }
    this._desiredArmed = desired
    // Reset the gesture on disarm, not on arm, so re-arming cannot fire an edge
    // off readings taken minutes ago in some other posture.
    if (!desired) {
      this._resetGesture()
      this._clearWatchdog()
      // A retry queued while arming would otherwise fire after this disarm and
      // switch the sensor back on, which is the battery failure this class exists
      // to prevent.
      this._clearRetry()
    } else {
      // Each fresh arm has to prove the stream is alive on its own: a reload or a
      // reconnect can leave the sensor off despite a successful enable earlier.
      this._sawSample = false
      this._rearms = 0
    }
    void this._drain()
  }

  // Fire-and-forget power-off for teardown. FOREGROUND_EXIT, SYSTEM_EXIT and
  // ABNORMAL_EXIT may all be followed by termination before a promise can settle,
  // so this issues the call without awaiting and updates local state immediately.
  // Nothing here can throw into the caller: a teardown path must keep going.
  releaseNow(): void {
    this._desiredArmed = false
    this._appliedArmed = false
    this._resetGesture()
    this._clearWatchdog()
    this._clearRetry()
    if (this._unavailable) return   // nothing was ever powered on
    try {
      void Promise.resolve(this._bridge.imuControl(false)).catch(() => {})
    } catch {
      /* bridge already gone; the OS powers the sensor down with the process */
    }
  }

  sample(raw: ImuSample): void {
    // Reports can still arrive after we asked for off, and acting on them would
    // toggle the view for a gesture nobody is arming.
    if (!this._desiredArmed) return

    // The stream is alive, so stop watching for a dead one.
    this._sawSample = true
    this._rearms = 0
    this._clearWatchdog()

    const x = raw.x ?? 0
    const y = raw.y ?? 0
    const z = raw.z ?? 0
    this._last = { x, y, z }

    const mag = Math.hypot(x, y, z)
    if (mag < MIN_MAGNITUDE) return

    const now = Date.now()
    const gap = this._lastSampleAt ? now - this._lastSampleAt : 0
    const dt = gap > 0 && gap <= MAX_GAP_MS ? gap : 0
    this._lastSampleAt = now

    const axis = axisOf(this._last, PITCH_AXIS)

    // The first usable sample fixes the *magnitude* reference, which is safe
    // because magnitude is ~1 g in every posture. The axis reference is NOT taken
    // from it: that value depends entirely on where the head happened to be
    // pointing, so it starts from the measured resting offset and is refined from
    // there only while the rider is demonstrably level.
    if (!this._haveRest) {
      this._restMag = mag
      // The constant is a fraction of gravity, and mag *is* gravity in whatever
      // units the host reports, so scaling by it keeps the seed unit-agnostic.
      this._restAxis = REST_AXIS_FRACTION * mag
      this._haveRest = true
    }

    const ref = this._restMag >= MIN_MAGNITUDE ? this._restMag : mag
    const ratio = Math.max(-1, Math.min(1, (PITCH_SIGN * (axis - this._restAxis)) / ref))
    const instant = (Math.asin(ratio) * 180) / Math.PI

    // Track the baseline only while clearly level. Two guards, because each stops a
    // different failure: the state guard keeps a revealed tilt from being absorbed,
    // and the angle guard keeps a *partial* tilt from being absorbed, which the
    // state guard cannot see since a tilt below the enter threshold never leaves
    // the level state. Without the second one, holding a 10 degree lean for a few
    // seconds would quietly redefine it as straight ahead and desensitise the
    // gesture by that much.
    // Track the baseline only while the rider is demonstrably level: not revealed,
    // and reading close to the current zero. Two guards, because each stops a
    // different failure. The state guard keeps a revealed tilt from being absorbed.
    // The angle guard keeps a *partial* tilt from being absorbed, which the state
    // guard cannot see, since a tilt below the enter threshold never leaves the
    // level state; without it, holding a 12 degree lean quietly redefines it as
    // straight ahead and desensitises the gesture by that much.
    //
    // There is deliberately no out-of-band recovery path. One was tried, on the
    // theory that a wrong baseline would otherwise be permanent, and it does not
    // work: tracking slowly outside the band pulls the reading down *into* the band,
    // where fast tracking then absorbs the lean completely. Slow absorption only
    // postpones it. Nothing distinguishes "wrong reference" from "sustained lean"
    // by reading alone, so the reference is anchored to a measured constant instead
    // and the whole problem is avoided at the seed.
    if (this._state === 'level' && Math.abs(instant) < EXIT_DEG) {
      const a = emaAlpha(dt, REST_TAU_MS)
      this._restMag += (mag - this._restMag) * a
      this._restAxis += (axis - this._restAxis) * a
    }

    // First usable sample has no gap to filter against, so adopt it outright
    // rather than easing up from a zero that was never a measurement.
    this._pitchDeg = dt === 0 ? instant : this._pitchDeg + (instant - this._pitchDeg) * emaAlpha(dt, PITCH_TAU_MS)

    this._advance(now)
  }

  private _advance(now: number): void {
    // Hysteresis: which threshold applies depends on where we already are.
    const want: TiltState =
      this._state === 'up'
        ? this._pitchDeg >= EXIT_DEG
          ? 'up'
          : 'level'
        : this._pitchDeg >= ENTER_DEG
          ? 'up'
          : 'level'

    if (want !== this._candidate) {
      this._candidate = want
      this._candidateSince = now
      return
    }
    if (want === this._state) return
    if (now - this._candidateSince < (want === 'up' ? ENTER_DWELL_MS : LEVEL_DWELL_MS)) return
    if (now - this._lastEdgeAt < COOLDOWN_MS) return

    this._state = want
    this._lastEdgeAt = now
    // Edges only. Per-sample callbacks would put a render decision on the
    // highest-frequency event in the app.
    if (want === 'up') this._onReveal()
    else this._onDismiss()
  }

  private _clearWatchdog(): void {
    if (this._watchdog) {
      clearTimeout(this._watchdog)
      this._watchdog = null
    }
  }

  private _clearRetry(): void {
    if (this._retry) {
      clearTimeout(this._retry)
      this._retry = null
    }
  }

  // Armed but silent means the enable did not really take. Re-issue it a couple of
  // times, then say so plainly rather than leaving a dead gesture looking enabled.
  private _armWatchdog(): void {
    this._clearWatchdog()
    this._watchdog = setTimeout(() => {
      this._watchdog = null
      if (!this._desiredArmed || this._sawSample) return
      if (this._rearms >= MAX_REARMS) {
        console.warn(
          `IMU armed but no reports after ${MAX_REARMS + 1} attempts; head tilt will not respond`,
        )
        return
      }
      this._rearms++
      console.warn(`IMU armed but silent, re-issuing enable (attempt ${this._rearms + 1})`)
      // Drop the applied flag so the drain has work to do, and re-issue.
      this._appliedArmed = false
      void this._drain()
    }, SAMPLE_WATCHDOG_MS)
  }

  private _resetGesture(): void {
    this._state = 'level'
    this._candidate = 'level'
    this._candidateSince = 0
    this._lastSampleAt = 0
    this._pitchDeg = 0
    // The resting baseline describes how the glasses sit on the face, not anything
    // about this gesture, so it deliberately survives a disarm and is ready on the
    // next arm rather than being relearned from whatever posture that lands in.
  }

  // Latest-wins drain. The loop re-reads _desiredArmed after every await, so an
  // arm/disarm pair that lands during a call cannot leave the sensor powered
  // after we asked for off, which is the failure mode that matters for battery.
  private async _drain(): Promise<void> {
    if (this._draining || this._unavailable) return
    this._draining = true
    try {
      while (this._appliedArmed !== this._desiredArmed) {
        const target = this._desiredArmed
        try {
          if (target) await this._bridge.imuControl(true, ImuReportPace.P200)
          else await this._bridge.imuControl(false)
          this._appliedArmed = target
          this._failures = 0
          // A successful enable is not proof of a live stream, so start watching.
          if (target) this._armWatchdog()
          else this._clearWatchdog()
        } catch (err) {
          // Break rather than retry in place: a failing bridge would spin here,
          // and the next policy change calls in again anyway.
          this._failures++
          if (this._failures >= MAX_CONTROL_FAILURES) {
            this._unavailable = true
            console.warn(`IMU unavailable, head tilt disabled after ${this._failures} attempts:`, err)
          } else {
            console.warn('imuControl failed:', err)
            // Come back to it rather than waiting for the policy to change.
            if (!this._retry) {
              this._retry = setTimeout(() => {
                this._retry = null
                void this._drain()
              }, CONTROL_RETRY_MS)
            }
          }
          break
        }
      }
    } finally {
      this._draining = false
    }
  }
}

// ── Calibration ─────────────────────────────────────────────────────────────
//
// PITCH_AXIS and PITCH_SIGN above are the only two values that cannot be derived
// at runtime, and they cannot be read off a phone or a console either: looking at
// a screen to read the number changes the pitch being measured. So the poses are
// captured by pressing the glasses while holding each one, and the recommendation
// is printed afterwards, once the head is free to move again.
//
// Three poses: level, looking up, looking down. Down is not part of the gesture
// but it is what proves the chosen axis is really pitch, since a pitch axis
// reverses between up and down while an unrelated axis does not.

// Straight ahead is captured twice, at the start and at the end. The second one
// is not a pose the gesture uses: it is a control. If the two disagree by more
// than the noise band then the glasses shifted on the face during the run, or the
// payload is a rate sensor whose zero drifts, and either way the numbers derived
// from the run cannot be trusted.
export type PoseLabel = 'level' | 'up' | 'down' | 'level2'
export const POSE_ORDER: PoseLabel[] = ['level', 'up', 'down', 'level2']

interface Pose {
  label: PoseLabel
  x: number
  y: number
  z: number
  mag: number
  noise: number // worst per-axis standard deviation, the noise floor for thresholds
  samples: number
  // Every sample in the window, kept so the raw trace can be inspected rather than
  // only the conclusion drawn from it. If the payload turns out to be a rate sensor
  // the means alone would look like noise, while the trace shows the decay.
  raw: Array<{ x: number; y: number; z: number }>
}

// Averaging window per pose. Long enough to average out hand and head tremor,
// short enough that holding the pose is not a chore.
const POSE_WINDOW_MS = 2000

export class TiltCalibrator {
  private _window: Array<{ t: number; x: number; y: number; z: number }> = []
  private _poses: Pose[] = []

  get captured(): number {
    return this._poses.length
  }

  get next(): PoseLabel | null {
    return POSE_ORDER[this._poses.length] ?? null
  }

  sample(raw: ImuSample): void {
    const now = Date.now()
    this._window.push({ t: now, x: raw.x ?? 0, y: raw.y ?? 0, z: raw.z ?? 0 })
    while (this._window.length && now - this._window[0].t > POSE_WINDOW_MS) this._window.shift()
  }

  has(label: PoseLabel): boolean {
    return this._poses.some(p => p.label === label)
  }

  // Freeze the trailing window as the named pose. The label is explicit rather
  // than taken from POSE_ORDER position, so a pose that captures nothing (the
  // stream stalled) cannot silently shift every later pose onto the wrong label.
  capture(label: PoseLabel): string {
    if (this.has(label)) return `Already captured "${label}"`
    if (this._window.length < 2) return `No IMU data for "${label}"`

    const n = this._window.length
    const mean = (get: (s: { x: number; y: number; z: number }) => number) =>
      this._window.reduce((a, s) => a + get(s), 0) / n
    const sd = (get: (s: { x: number; y: number; z: number }) => number, m: number) =>
      Math.sqrt(this._window.reduce((a, s) => a + (get(s) - m) ** 2, 0) / n)

    const x = mean(s => s.x)
    const y = mean(s => s.y)
    const z = mean(s => s.z)
    const noise = Math.max(sd(s => s.x, x), sd(s => s.y, y), sd(s => s.z, z))

    this._poses.push({
      label,
      x,
      y,
      z,
      mag: Math.hypot(x, y, z),
      noise,
      samples: n,
      raw: this._window.map(s => ({ x: s.x, y: s.y, z: s.z })),
    })
    this._window = []

    return `Captured ${label} (${n} samples)`
  }

  // Multi-line report. Printed to the console and surfaced in the web app's
  // status line, so it is readable without devtools on the phone.
  report(): string {
    const byLabel = (l: PoseLabel) => this._poses.find(p => p.label === l)
    const level = byLabel('level')
    const up = byLabel('up')
    const down = byLabel('down')
    const level2 = byLabel('level2')
    if (!level || !up || !down) {
      const missing = POSE_ORDER.filter(l => !this.has(l))
      return `Calibration incomplete, missing: ${missing.join(', ')}`
    }

    const lines: string[] = []
    for (const p of this._poses) {
      lines.push(
        `${p.label.padEnd(6)} x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} z=${p.z.toFixed(3)} |v|=${p.mag.toFixed(3)} noise=${p.noise.toFixed(4)}`,
      )
    }

    // Resting magnitude names the units: ~1 is g, ~9.8 is m/s^2, anything else is
    // raw counts. Either way the detector divides it out.
    const unit =
      Math.abs(level.mag - 1) < 0.2
        ? 'g'
        : Math.abs(level.mag - 9.81) < 1.5
          ? 'm/s^2'
          : 'raw counts'
    lines.push(`resting magnitude ${level.mag.toFixed(3)} (${unit})`)

    // The repeatability control. A large gap between the two straight-ahead poses
    // invalidates everything below it, so it is reported before the recommendation
    // rather than after.
    if (level2) {
      const drift = Math.hypot(level2.x - level.x, level2.y - level.y, level2.z - level.z)
      const band = Math.max(level.noise, level2.noise) * 3
      lines.push(
        `straight-ahead drift ${drift.toFixed(4)} vs noise band ${band.toFixed(4)}` +
          (drift > band ? '  <-- EXCEEDS, treat the numbers below as unreliable' : '  (within tolerance)'),
      )
    }

    const axes: Array<keyof ImuSample> = ['x', 'y', 'z']
    const scored = axes.map(a => {
      const dUp = (up[a] as number) - (level[a] as number)
      const dDown = (down[a] as number) - (level[a] as number)
      return {
        axis: a,
        dUp,
        dDown,
        // A real pitch axis moves in opposite directions for up and down. Summing
        // the magnitudes ranks how much it moves; the sign test below rejects
        // axes that merely drifted.
        travel: Math.abs(dUp) + Math.abs(dDown),
        reverses: dUp * dDown < 0,
      }
    })
    for (const s of scored) {
      lines.push(
        `axis ${s.axis}: up ${s.dUp >= 0 ? '+' : ''}${s.dUp.toFixed(3)}  down ${s.dDown >= 0 ? '+' : ''}${s.dDown.toFixed(3)}  travel ${s.travel.toFixed(3)}${s.reverses ? '  reverses' : ''}`,
      )
    }

    const reversing = scored.filter(s => s.reverses).sort((a, b) => b.travel - a.travel)
    const best = reversing[0]
    if (!best) {
      lines.push('')
      lines.push('No axis reverses between up and down. Either the poses were not held,')
      lines.push('or the payload is a rate sensor rather than an accelerometer, in which')
      lines.push('case pose thresholds cannot work and the fallback is press-to-reveal.')
      return lines.join('\n')
    }

    const sign = best.dUp > 0 ? 1 : -1
    const ref = level.mag >= MIN_MAGNITUDE ? level.mag : 1
    const deg = (v: number) => (Math.asin(Math.max(-1, Math.min(1, v / ref))) * 180) / Math.PI
    const upDeg = deg(sign * ((up[best.axis] as number) - (level[best.axis] as number)))
    const noiseDeg = deg(Math.max(level.noise, MIN_MAGNITUDE))

    // Enter comfortably inside the pose the user actually held, exit around a
    // third of the way back, and never closer to level than the measured noise.
    const enter = Math.max(Math.round(upDeg * 0.6), Math.ceil(noiseDeg * 3), 8)
    const exit = Math.max(Math.round(upDeg * 0.3), Math.ceil(noiseDeg * 2), 4)

    lines.push('')
    lines.push(`Measured up pose: ${upDeg.toFixed(1)} deg (noise ~${noiseDeg.toFixed(1)} deg)`)
    lines.push('Set these in src/tilt.ts:')
    lines.push(`  const PITCH_AXIS: keyof ImuSample = '${best.axis}'`)
    lines.push(`  const PITCH_SIGN = ${sign}`)
    lines.push(`  const ENTER_DEG = ${enter}`)
    lines.push(`  const EXIT_DEG = ${Math.min(exit, enter - 2)}`)
    if (upDeg < 12) {
      lines.push('')
      lines.push(`Warning: ${upDeg.toFixed(1)} deg is a small pose. Hold a more pronounced`)
      lines.push('look-up and re-run, or the gesture will fire while reading a board.')
    }
    return lines.join('\n')
  }

  // Everything captured, for shipping off the device. The raw traces are the point:
  // they let the recommendation be checked rather than taken on trust.
  snapshot(): unknown {
    return {
      poses: this._poses.map(p => ({
        label: p.label,
        mean: { x: p.x, y: p.y, z: p.z },
        magnitude: p.mag,
        noise: p.noise,
        samples: p.samples,
        raw: p.raw,
      })),
    }
  }

  reset(): void {
    this._window = []
    this._poses = []
  }
}

// ── The timed run ───────────────────────────────────────────────────────────
//
// Drives the whole capture from a timer and puts the instructions on the glasses,
// so the rider never touches a control and never looks away from the display. The
// alternative (press to capture each pose) is worse on this hardware: the controls
// are behind the ear and on the ring rather than under the instructions, and a
// long press exits the app, which puts the abort gesture next to the capture one.
//
// Each pose gets a settle period followed by the window that is actually averaged,
// and the hint line says which phase it is in, so the rider knows when holding
// still counts.
const SETTLE_MS = 3000
const HOLD_MS = POSE_WINDOW_MS // the averaged window, so the phase ends as it fills
const INTRO_MS = 3000
const TICK_MS = 250

interface Phase {
  instruction: string
  capture: PoseLabel | null
}

const PHASES: Phase[] = [
  { instruction: 'GET READY', capture: null },
  { instruction: 'LOOK STRAIGHT AHEAD', capture: 'level' },
  { instruction: 'LOOK UP', capture: 'up' },
  { instruction: 'LOOK DOWN', capture: 'down' },
  { instruction: 'LOOK STRAIGHT AHEAD', capture: 'level2' },
]

export type CalibrationRender = (instruction: string, countdown: string, hint: string) => void

export class TiltCalibrationRunner {
  private _calibrator: TiltCalibrator
  private _render: CalibrationRender
  private _onDone: (report: string, snapshot: unknown) => void
  private _timer: ReturnType<typeof setInterval> | null = null
  private _index = 0
  private _phaseStart = 0
  private _lastPainted = ''
  private _running = false

  constructor(
    calibrator: TiltCalibrator,
    render: CalibrationRender,
    onDone: (report: string, snapshot: unknown) => void,
  ) {
    this._calibrator = calibrator
    this._render = render
    this._onDone = onDone
  }

  get running(): boolean {
    return this._running
  }

  start(): void {
    if (this._running) return
    this._running = true
    this._index = 0
    this._phaseStart = Date.now()
    this._paint()
    // Ticks faster than the countdown changes so a phase boundary is never missed
    // by up to a second; _paint dedupes, so the extra ticks cost no BLE traffic.
    this._timer = setInterval(() => this._tick(), TICK_MS)
  }

  cancel(): void {
    this._running = false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  private _phaseLength(phase: Phase): number {
    return phase.capture ? SETTLE_MS + HOLD_MS : INTRO_MS
  }

  private _tick(): void {
    if (!this._running) return
    const phase = PHASES[this._index]
    if (!phase) return
    const elapsed = Date.now() - this._phaseStart

    if (elapsed < this._phaseLength(phase)) {
      this._paint()
      return
    }

    // Phase over: freeze the window before moving on, since the next phase's
    // samples would otherwise contaminate it.
    if (phase.capture) {
      const line = this._calibrator.capture(phase.capture)
      console.log(`[tilt] ${line}`)
    }

    this._index++
    this._phaseStart = Date.now()
    if (this._index >= PHASES.length) {
      this.cancel()
      const report = this._calibrator.report()
      this._render('DONE', '', 'sent to the dev server')
      this._onDone(report, this._calibrator.snapshot())
      return
    }
    this._paint()
  }

  private _paint(): void {
    const phase = PHASES[this._index]
    if (!phase) return
    const length = this._phaseLength(phase)
    const elapsed = Date.now() - this._phaseStart
    const secondsLeft = Math.max(1, Math.ceil((length - elapsed) / 1000))

    const holding = phase.capture !== null && elapsed >= SETTLE_MS
    const hint = phase.capture === null
      ? `step 1 of ${PHASES.length}`
      : holding
        ? `HOLD STILL - measuring - step ${this._index + 1} of ${PHASES.length}`
        : `get into position - step ${this._index + 1} of ${PHASES.length}`

    // One BLE call per visible change, not per tick.
    const frame = `${phase.instruction}|${secondsLeft}|${hint}`
    if (frame === this._lastPainted) return
    this._lastPainted = frame
    this._render(phase.instruction, String(secondsLeft), hint)
  }
}
