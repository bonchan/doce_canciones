// This server as a device on core2's MQTT bus, speaking exactly what the ESP32s speak (see
// core2/arduino/device_base.h, and wind_world's mqtt_device.gd for another desktop one):
//   installation/<zone>/<id>/status     "online" / "offline"    retained, last will
//   installation/<zone>/<id>/announce   identity + capabilities retained
//   installation/<zone>/<id>/telemetry  JSON, every few seconds (core2 marks a device offline
//                                       after 15 s of silence)
//   installation/<zone>/<id>/cmd/<CAP>  commands addressed to it
//   installation/broadcast/<type>/cmd/<CAP>  commands to every device of its type
import crypto from 'node:crypto'
import os from 'node:os'
import { connect, type MqttClient } from 'mqtt'

export interface DeviceOptions {
  broker: string // mqtt://host:1883
  username: string
  password: string
  zone: string
  name: string
  type: string
  fw: string
  publishes: string[]
  subscribes: string[]
  announceExtra: () => Record<string, unknown> // anything a core2 page needs to offer controls
  telemetry: () => Record<string, unknown>
  onCommand: (capability: string, params: Record<string, unknown>) => void
  telemetryMs?: number
}

export interface Device {
  id: string
  announce(): void // again, when something in announceExtra changed
}

// 12 hex digits like the ESP32s' MAC ids, stable for this machine and device name
const deviceId = (name: string) =>
  crypto.createHash('sha1').update(`${os.hostname()}|${name}`).digest('hex').slice(0, 12).toUpperCase()

export function startDevice(o: DeviceOptions): Device {
  const id = deviceId(o.name)
  const base = `installation/${o.zone}/${id}`
  const cmdPrefix = `${base}/cmd/`
  const broadcastPrefix = `installation/broadcast/${o.type}/cmd/`

  const client: MqttClient = connect(o.broker, {
    clientId: `${o.name}-${id}`,
    username: o.username || undefined,
    password: o.password || undefined,
    reconnectPeriod: 10_000,
    connectTimeout: 10_000,
    // if this process dies, the broker says so on its behalf
    will: { topic: `${base}/status`, payload: Buffer.from('offline'), qos: 1, retain: true },
  })

  const announce = () => {
    if (!client.connected) return
    const payload = {
      type: o.type,
      fw: o.fw,
      sn: o.name,
      capabilities: { publishes: o.publishes, subscribes: o.subscribes },
      ...o.announceExtra(),
    }
    client.publish(`${base}/announce`, JSON.stringify(payload), { qos: 1, retain: true })
  }

  client.on('connect', () => {
    console.log(`[mqtt] connected to ${o.broker} as ${o.type} ${id} (zone ${o.zone})`)
    client.subscribe([`${cmdPrefix}#`, `${broadcastPrefix}#`], { qos: 1 })
    client.publish(`${base}/status`, 'online', { qos: 1, retain: true })
    announce()
  })
  let lastError = ''
  client.on('error', (e) => {
    if (e.message !== lastError) console.error(`[mqtt] ${e.message}`) // not every 10 s retry
    lastError = e.message
  })
  client.on('close', () => {
    if (lastError !== 'closed') console.log('[mqtt] disconnected, retrying every 10 s')
    lastError = 'closed'
  })

  client.on('message', (topic, payload) => {
    const capability = topic.startsWith(cmdPrefix)
      ? topic.slice(cmdPrefix.length)
      : topic.startsWith(broadcastPrefix)
        ? topic.slice(broadcastPrefix.length)
        : ''
    if (!capability) return
    let params: Record<string, unknown> = {}
    try {
      const parsed = payload.length ? JSON.parse(payload.toString()) : {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed
    } catch {
      // not JSON: no params
    }
    console.log(`[mqtt] CMD ${capability} ${JSON.stringify(params)}`)
    try {
      o.onCommand(capability, params)
    } catch (e) {
      console.error(`[mqtt] ${capability} failed:`, e)
    }
  })

  setInterval(() => {
    if (client.connected) client.publish(`${base}/telemetry`, JSON.stringify(o.telemetry()))
  }, o.telemetryMs ?? 3000)

  const goodbye = () => {
    if (client.connected) client.publish(`${base}/status`, 'offline', { qos: 1, retain: true })
    client.end(false)
  }
  process.on('SIGINT', goodbye)
  process.on('SIGTERM', goodbye)

  return { id, announce }
}
