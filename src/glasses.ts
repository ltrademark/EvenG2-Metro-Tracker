import type {
  EvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { Station, Train } from './wmata'

const HEADER_ID = 1
const LIST_ID = 2
const STATUS_ID = 3
const HEADER_NAME = 'header'
const LIST_NAME = 'arrivals'
const STATUS_NAME = 'status'

const W = 576
const HEADER_Y = 0
const HEADER_H = 40
const LIST_Y = 40
const LIST_H = 200
const STATUS_Y = 240
const STATUS_H = 28

function formatMin(min: string): string {
  if (min === 'ARR' || min === 'BRD') return min
  return `${min}m`
}

function formatRow(train: Train): string {
  const line = train.line.slice(0, 2).padEnd(2)
  const minStr = formatMin(train.min)
  const prefix = `${line}  `
  const suffix = `  ${minStr}`
  // List items are capped at 64 chars by the SDK
  const maxDest = 64 - prefix.length - suffix.length
  const dest =
    train.destination.length > maxDest
      ? train.destination.slice(0, maxDest - 1) + '…'
      : train.destination
  return `${prefix}${dest}${suffix}`
}

function makeContainers(headerContent: string, items: string[], statusContent: string) {
  const header: TextContainerProperty = {
    xPosition: 0,
    yPosition: HEADER_Y,
    width: W,
    height: HEADER_H,
    containerID: HEADER_ID,
    containerName: HEADER_NAME,
    content: headerContent,
    borderWidth: 0,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: 4,
    isEventCapture: 1,
  }

  const list: ListContainerProperty = {
    xPosition: 0,
    yPosition: LIST_Y,
    width: W,
    height: LIST_H,
    containerID: LIST_ID,
    containerName: LIST_NAME,
    isEventCapture: 0,
    borderWidth: 0,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: 0,
    itemContainer: {
      itemCount: items.length,
      itemName: items,
      itemWidth: 0,
      isItemSelectBorderEn: 0,
    },
  }

  const status: TextContainerProperty = {
    xPosition: 0,
    yPosition: STATUS_Y,
    width: W,
    height: STATUS_H,
    containerID: STATUS_ID,
    containerName: STATUS_NAME,
    content: statusContent,
    borderWidth: 0,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: 2,
    isEventCapture: 0,
  }

  return { header, list, status }
}

export class GlassesDisplay {
  private _bridge: EvenAppBridge
  private _rendering = false

  constructor(bridge: EvenAppBridge) {
    this._bridge = bridge
  }

  async startup(): Promise<boolean> {
    const { header, list, status } = makeContainers(
      'WMATA TRACKER',
      ['Locating station…'],
      'Starting…',
    )
    const result = await this._bridge.createStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [header, status],
      listObject: [list],
    })
    return result === 0
  }

  async render(station: Station, trains: Train[], distKm: number, updatedAt: Date): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    const distMi = (distKm * 0.621371).toFixed(1)
    const timeStr = updatedAt.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const items = trains.length > 0 ? trains.map(formatRow) : ['No trains found']
    const { header, list, status } = makeContainers(
      station.name.toUpperCase(),
      items,
      `${timeStr}  • ${distMi}mi`,
    )

    try {
      await Promise.race([
        this._bridge.rebuildPageContainer({
          containerTotalNum: 3,
          textObject: [header, status],
          listObject: [list],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('render timeout')), 5000),
        ),
      ])
    } catch (err) {
      console.error('GlassesDisplay render error:', err)
    } finally {
      this._rendering = false
    }
  }

  async updateStatus(text: string): Promise<void> {
    try {
      await this._bridge.textContainerUpgrade({
        containerID: STATUS_ID,
        containerName: STATUS_NAME,
        content: text,
        contentOffset: 0,
        contentLength: 0,
      })
    } catch (err) {
      console.error('updateStatus error:', err)
    }
  }
}
