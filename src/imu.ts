import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { ImuReportPace } from '@evenrealities/even_hub_sdk'

// Tune this threshold on hardware — sign/magnitude depends on glasses orientation
const IMU_PITCH_THRESHOLD = 8.0
const GESTURE_DEBOUNCE_MS = 2000
const IMU_BUFFER_SIZE = 3

export class ImuController {
  private _bridge: EvenAppBridge
  private _onHeadUp: () => void
  private _onHeadDown: () => void
  private _zBuffer: number[] = []
  private _lastGestureAt = 0
  private _unsubscribe: (() => void) | null = null

  constructor(bridge: EvenAppBridge, onHeadUp: () => void, onHeadDown: () => void) {
    this._bridge = bridge
    this._onHeadUp = onHeadUp
    this._onHeadDown = onHeadDown
  }

  async start() {
    await this._bridge.imuControl(true, ImuReportPace.P500)
    this._unsubscribe = this._bridge.onEvenHubEvent(event => {
      // imuData is present on sysEvent when an IMU report arrives
      const imuData = (event.sysEvent as { imuData?: { x: number; y: number; z: number } })
        ?.imuData
      if (!imuData) return

      this._zBuffer.push(imuData.z)
      if (this._zBuffer.length > IMU_BUFFER_SIZE) this._zBuffer.shift()
      if (this._zBuffer.length < IMU_BUFFER_SIZE) return

      const avg = this._zBuffer.reduce((a, b) => a + b, 0) / IMU_BUFFER_SIZE
      const now = Date.now()
      if (now - this._lastGestureAt < GESTURE_DEBOUNCE_MS) return

      if (avg < -IMU_PITCH_THRESHOLD) {
        this._lastGestureAt = now
        this._onHeadUp()
      } else if (avg > IMU_PITCH_THRESHOLD) {
        this._lastGestureAt = now
        this._onHeadDown()
      }
    })
  }

  stop() {
    void this._bridge.imuControl(false)
    if (this._unsubscribe) {
      this._unsubscribe()
      this._unsubscribe = null
    }
  }
}
