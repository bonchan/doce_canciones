import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { wordField } from '../art/field.ts'
import { phraseSeed } from '../art/phrases.ts'
import { COLORS, FONT } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { reloadDisplay, reportError } from '../errors.ts'
import { fmt, num, strings } from '../i18n.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { HORIZON_RADIUS_KM, bearing, type GeoPoint, type Station } from '../orbit.ts'
import { CAMERA } from '../params.ts'
import type { SharedConfig } from '../shared/protocol.ts'
import { APPROACH_SIM, activeSlot, geometryFor, phaseAt, satTimeAt, stationFor } from '../timeline.ts'
import { GlobeWords } from './globeWords.ts'

const color = (css: string, alpha = 1) => Cesium.Color.fromCssColorString(css).withAlpha(alpha)
const atAlt = (g: GeoPoint) => Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.alt * 1000)
const onGround = (g: GeoPoint) => Cesium.Cartesian3.fromRadians(g.lon, g.lat, 0)

// 9000 km from the station, pitched 80° down, looking north
const VIEW_RANGE = 9_000_000
const VIEW_PITCH = Cesium.Math.toRadians(-80)
// follow camera: behind and above the satellite, looking along its track
const FOLLOW_RANGE = 3_200_000
const FOLLOW_PITCH = Cesium.Math.toRadians(-35)

function flyToStation(viewer: Cesium.Viewer, station: Station, duration = 2) {
  const back = VIEW_RANGE * Math.cos(VIEW_PITCH) // ground offset to the south, m
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat - Cesium.Math.toDegrees(back / Cesium.Ellipsoid.WGS84.maximumRadius),
      -VIEW_RANGE * Math.sin(VIEW_PITCH),
    ),
    orientation: { heading: 0, pitch: VIEW_PITCH, roll: 0 },
    duration,
  })
}

function setImagery(viewer: Cesium.Viewer, imagery: SharedConfig['imagery']) {
  const layers = viewer.imageryLayers
  layers.removeAll()
  // bundled with Cesium, always available offline
  layers.add(
    Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')),
    ),
  )
  if (imagery === 'esri') {
    layers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 18,
        credit: 'Esri, Maxar, Earthstar Geographics',
      }),
    )
  }
}

const finite = (g: GeoPoint) => Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(g.alt)

export function GlobeView() {
  const l = useLink()
  const now = useTicker(250)
  const slot = activeSlot(l.state, now)
  const imagery = l.state?.config.imagery
  const location = l.state?.config.location
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const sourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const wordsRef = useRef<GlobeWords | null>(null)
  const slotId = slot?.id ?? null
  const passId = slot?.pass.id ?? null
  const phrasesOn = l.state?.config.phrases ?? false
  const language = l.state?.config.language

  useEffect(() => {
    if (import.meta.env.VITE_CESIUM_TOKEN) Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN
    const viewer = new Cesium.Viewer(containerRef.current!, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
    })
    viewer.scene.globe.showGroundAtmosphere = true
    const source = new Cesium.CustomDataSource('pass')
    viewer.dataSources.add(source)
    viewerRef.current = viewer
    sourceRef.current = source
    wordsRef.current = new GlobeWords(viewer)

    // After an error Cesium stops rendering and shows a panel: report it instead, start the
    // loop again, and reload the display if it keeps failing (more than 3 times a minute)
    viewer.cesiumWidget.showErrorPanel = (title, message, error) => reportError(`globe: ${title} ${message ?? ''}`, error)
    const failures: number[] = []
    const watchdog = window.setInterval(() => {
      if (viewer.isDestroyed() || viewer.useDefaultRenderLoop) return
      const now = Date.now()
      failures.push(now)
      while (failures[0] < now - 60_000) failures.shift()
      if (failures.length > 3 && reloadDisplay('the globe kept failing')) window.clearInterval(watchdog)
      else viewer.useDefaultRenderLoop = true
    }, 1000)

    return () => {
      window.clearInterval(watchdog)
      viewerRef.current = null
      viewer.destroy()
    }
  }, [])

  useEffect(() => {
    if (viewerRef.current && imagery) setImagery(viewerRef.current, imagery)
  }, [imagery])

  // the phrase words around the Earth (art/field.ts): the same words, shuffled with each pass
  useEffect(() => {
    const words = wordsRef.current
    const config = link.state?.config
    const s0 = liveSlot(slotId)
    if (!words) return
    if (!s0 || !config || !phrasesOn) {
      words.clear()
      return
    }
    const g = geometryFor(s0.pass, config)
    const field = wordField(phraseSeed(s0.id, s0.pass.id), strings().phrases, g)
    const satT = () => {
      const s = liveSlot(slotId)
      return s ? satTimeAt(s, g, link.now()) : g.tLos + 600
    }
    let alive = true
    // the words become images: wait for the font, or they'd keep the fallback one
    document.fonts
      .load(`600 96px ${FONT}`)
      .catch(() => {})
      .finally(() => {
        if (alive) words.show(field, satT)
      })
    return () => {
      alive = false
    }
  }, [slotId, passId, location, phrasesOn, language])

  useEffect(() => {
    const viewer = viewerRef.current
    const ds = sourceRef.current
    const config = link.state?.config
    const s0 = liveSlot(slotId)
    if (!viewer || !ds) return
    ds.entities.removeAll()
    if (!s0 || !config) return

    const pass = s0.pass
    const g = geometryFor(pass, config)
    const station = stationFor(pass, config)
    const stationPos = Cesium.Cartesian3.fromDegrees(station.lon, station.lat)
    const satT = () => {
      const s = liveSlot(slotId)
      return s ? satTimeAt(s, g, link.now()) : g.tLos + 600
    }
    // the last finite position: a NaN handed to Cesium throws and stops its rendering
    let lastPos = atAlt(g.geo(g.tAos - APPROACH_SIM))
    const satPos = () => {
      const p = g.geo(satT())
      if (finite(p)) lastPos = atAlt(p)
      return lastPos
    }
    const receiving = () => {
      const s = liveSlot(slotId)
      return !!s && phaseAt(s, link.now()) === 'pass'
    }

    ds.entities.add({
      position: stationPos,
      point: { pixelSize: 9, color: color(COLORS.station), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
      label: {
        text: station.name,
        font: `15px ${FONT}`,
        fillColor: Cesium.Color.WHITE,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(0, -18),
      },
    })
    // a satellite at 850 km is above the station's horizon while its sub-point is inside this circle
    ds.entities.add({
      position: stationPos,
      ellipse: {
        semiMajorAxis: HORIZON_RADIUS_KM * 1000,
        semiMinorAxis: HORIZON_RADIUS_KM * 1000,
        height: 0,
        material: color(COLORS.station, 0.06),
        outline: true,
        outlineColor: color(COLORS.station, 0.6),
      },
    })

    const orbit: Cesium.Cartesian3[] = []
    for (let t = -g.period / 2; t <= g.period / 2; t += 30) orbit.push(atAlt(g.geo(t)))
    ds.entities.add({
      polyline: { positions: orbit, width: 1, arcType: Cesium.ArcType.NONE, material: color(COLORS.sat, 0.25) },
    })

    const t0 = g.tAos - APPROACH_SIM
    const step = 10
    const samples: GeoPoint[] = []
    for (let t = t0; t <= g.tLos + 600; t += step) samples.push(g.geo(t))
    ds.entities.add({
      polyline: {
        positions: samples.map(onGround),
        width: 2,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({ color: color(COLORS.sat, 0.6), dashLength: 12 }),
      },
    })
    const flown = samples.map(atAlt)
    ds.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const n = Math.max(0, Math.min(flown.length, Math.floor((satT() - t0) / step) + 1))
          return [...flown.slice(0, n), satPos()]
        }, false),
        width: 3,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({ color: color(COLORS.sat), glowPower: 0.25 }),
      },
    })
    ds.entities.add({
      polyline: {
        show: new Cesium.CallbackProperty(() => g.look(satT()).elevation > 0, false),
        positions: new Cesium.CallbackProperty(() => [stationPos, satPos()], false),
        width: 2,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({ color: color(COLORS.rx), dashLength: 8 }),
      },
    })
    ds.entities.add({
      position: new Cesium.CallbackPositionProperty(satPos, false),
      point: {
        pixelSize: 13,
        color: new Cesium.CallbackProperty(() => (receiving() ? color(COLORS.rx) : color(COLORS.sat)), false),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: new Cesium.CallbackProperty(() => {
          const el = g.look(satT()).elevation
          return el > 0 ? `${pass.satellite}\n${fmt(strings().globe.elevation, { el: num(el) })}` : pass.satellite
        }, false),
        font: `14px ${FONT}`,
        fillColor: Cesium.Color.WHITE,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(14, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    if (CAMERA === 'station') {
      flyToStation(viewer, station)
      return
    }
    // a frame with a bad position or camera is skipped (the camera stays where it was)
    return viewer.scene.preRender.addEventListener(() => {
      try {
        const t = satT()
        const here = g.geo(t)
        const ahead = g.geo(t + 20)
        const heading = bearing(here, ahead)
        if (!finite(here) || !finite(ahead) || !Number.isFinite(heading)) return
        viewer.camera.lookAt(atAlt(here), new Cesium.HeadingPitchRange(heading, FOLLOW_PITCH, FOLLOW_RANGE))
      } catch (e) {
        reportError('follow camera', e)
      }
    })
  }, [slotId, passId, location])

  return (
    <Display title={CAMERA === 'follow' ? 'tracking' : 'orbit'}>
      <div ref={containerRef} className="globe" />
    </Display>
  )
}
