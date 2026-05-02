import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { feature } from 'topojson-client'
import landTopology from 'world-atlas/land-110m.json'
import 'leaflet/dist/leaflet.css'
import type { ForecastCollection, ForecastPayload, MapFieldPoint, VelocityRecord } from '../types'

type Props = {
  collection: ForecastCollection
  selectedSpotId: string
  onSelectSpot: (spotId: string) => void
  onVisibleSpotIdsChange?: (spotIds: string[]) => void
}

type LeafletVelocityLayer = L.Layer & {
  setData?: (data: unknown) => void
  _map?: L.Map
  _container?: HTMLElement
}

type LeafletWithVelocity = typeof L & {
  velocityLayer?: (options: Record<string, unknown>) => LeafletVelocityLayer
}

const velocityLeaflet = L as LeafletWithVelocity
const webcamIcon = L.divIcon({
  className: 'webcam-pin',
  html: '<span>📷</span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

const clampVelocityData = (records: VelocityRecord[]) => {
  if (records.length < 2) return records

  const [uRecord, vRecord] = records
  const maxReasonableSpeed = 8
  const maxHardSpeed = 14
  const nextU = [...uRecord.data]
  const nextV = [...vRecord.data]

  for (let index = 0; index < nextU.length; index += 1) {
    const u = nextU[index] ?? 0
    const v = nextV[index] ?? 0
    const magnitude = Math.sqrt(u * u + v * v)

    if (magnitude > maxHardSpeed) {
      nextU[index] = 0
      nextV[index] = 0
      continue
    }

    if (magnitude > maxReasonableSpeed) {
      const scale = maxReasonableSpeed / magnitude
      nextU[index] = Number((u * scale).toFixed(3))
      nextV[index] = Number((v * scale).toFixed(3))
    }
  }

  return [
    { ...uRecord, data: nextU },
    { ...vRecord, data: nextV },
  ]
}

const cleanupVelocityLayer = (map: L.Map | null, layer: LeafletVelocityLayer | null) => {
  if (!map || !layer) return
  try {
    map.removeLayer(layer)
  } catch {
    // ignore third-party cleanup errors
  }
  if (layer._container) {
    layer._container.remove()
  }
}

const distanceSquared = (forecast: ForecastPayload, latitude: number, longitude: number) => {
  const latDelta = forecast.spot.latitude - latitude
  const lonDelta = forecast.spot.longitude - longitude
  return latDelta * latDelta + lonDelta * lonDelta
}

const pointDistanceSquared = (point: MapFieldPoint, latitude: number, longitude: number) => {
  const latDelta = point.latitude - latitude
  const lonDelta = point.longitude - longitude
  return latDelta * latDelta + lonDelta * lonDelta
}

export function WorldMap({
  collection,
  selectedSpotId,
  onSelectSpot,
  onVisibleSpotIdsChange,
}: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const markersLayerRef = useRef<L.LayerGroup | null>(null)
  const webcamLayerRef = useRef<L.LayerGroup | null>(null)
  const landMaskLayerRef = useRef<L.GeoJSON | null>(null)
  const velocityLayerRef = useRef<LeafletVelocityLayer | null>(null)
  const velocityDataRef = useRef<VelocityRecord[]>([])
  const interactionTimerRef = useRef<number | null>(null)
  const [velocityReady, setVelocityReady] = useState(false)

  const webcamCount = useMemo(
    () => collection.spots.filter((spot) => Boolean(spot.spot.webcamUrl)).length,
    [collection.spots],
  )

  const nearestFieldPoint = useCallback(
    (latitude: number, longitude: number) => {
      if (!collection.mapField.points.length) return null
      return collection.mapField.points.reduce((best, point) =>
        pointDistanceSquared(point, latitude, longitude) < pointDistanceSquared(best, latitude, longitude)
          ? point
          : best,
      )
    },
    [collection.mapField.points],
  )

  const visibleSpotUpdater = useCallback(() => {
    const map = mapRef.current
    if (!map || !onVisibleSpotIdsChange) return

    const bounds = map.getBounds()
    const center = map.getCenter()
    const visibleIds = collection.spots
      .filter((forecast) => bounds.pad(0.12).contains([forecast.spot.latitude, forecast.spot.longitude]))
      .sort((a, b) => distanceSquared(a, center.lat, center.lng) - distanceSquared(b, center.lat, center.lng))
      .map((forecast) => forecast.spot.id)

    onVisibleSpotIdsChange(visibleIds)
  }, [collection.spots, onVisibleSpotIdsChange])

  useEffect(() => {
    let active = true

    const initVelocity = async () => {
      ;(globalThis as { L?: typeof L }).L = L
      try {
        await import('leaflet-velocity')
      } catch {
        // ignore; readiness check below will stay false
      }
      if (active) {
        setVelocityReady(Boolean((L as LeafletWithVelocity).velocityLayer))
      }
    }

    void initVelocity()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return

    const map = L.map(mapElementRef.current, {
      worldCopyJump: true,
      zoomControl: true,
      minZoom: 2,
      maxZoom: 11,
      preferCanvas: true,
    }).setView([18, 0], 2)

    map.createPane('landMaskPane')
    map.getPane('landMaskPane')!.style.zIndex = '420'
    map.createPane('webcamPane')
    map.getPane('webcamPane')!.style.zIndex = '460'
    map.createPane('spotsPane')
    map.getPane('spotsPane')!.style.zIndex = '470'

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      noWrap: false,
    }).addTo(map)

    markersLayerRef.current = L.layerGroup().addTo(map)
    webcamLayerRef.current = L.layerGroup().addTo(map)

    const worldAtlas = landTopology as unknown as { objects: { land: unknown } }
    const landGeoJson = feature(worldAtlas as never, worldAtlas.objects.land as never)
    landMaskLayerRef.current = L.geoJSON(landGeoJson as GeoJSON.GeoJsonObject, {
      pane: 'landMaskPane',
      interactive: false,
      style: {
        fillColor: '#08111d',
        fillOpacity: 0.94,
        color: 'rgba(10, 24, 44, 0.9)',
        weight: 0.6,
      },
    }).addTo(map)

    mapRef.current = map
    visibleSpotUpdater()

    return () => {
      cleanupVelocityLayer(map, velocityLayerRef.current)
      velocityLayerRef.current = null
      landMaskLayerRef.current?.remove()
      map.remove()
      mapRef.current = null
    }
  }, [visibleSpotUpdater])

  const mountVelocityLayer = useCallback(() => {
    const map = mapRef.current
    if (!map || !velocityReady || !velocityLeaflet.velocityLayer) return

    cleanupVelocityLayer(map, velocityLayerRef.current)
    velocityLayerRef.current = null

    const zoom = map.getZoom()
    const particleMultiplier = Math.min(0.02, 0.004 + Math.max(zoom - 2, 0) * 0.002)
    const lineWidth = Math.min(4.4, 2.4 + Math.max(zoom - 2, 0) * 0.24)
    const particleAge = Math.max(18, 42 - Math.max(zoom - 2, 0) * 2)

    const velocityLayer = velocityLeaflet.velocityLayer({
      data: velocityDataRef.current,
      displayValues: false,
      velocityScale: 0.004,
      opacity: 0.92,
      maxVelocity: 8,
      minVelocity: 0.02,
      particleMultiplier,
      lineWidth,
      colorScale: ['#16324f', '#1b4d70', '#23769c', '#2ca7d8', '#83d9ea'],
      frameRate: 24,
      particleAge,
      fadeOpacity: 0.97,
      animationDuration: 0,
      bounds: [[-70, -180], [70, 180]],
      wrapX: false,
      noWrap: true,
      minZoom: 0,
      maxZoom: 12,
      particleReduction: 1,
      dynamicOpacity: true,
      velocityOpacity: (velocity: number, u?: number, v?: number) => {
        const magnitude =
          u !== undefined && v !== undefined
            ? Math.sqrt(u * u + v * v)
            : velocity

        if (magnitude > 10) return 0
        const normalized = Math.min(magnitude / 6, 1)
        return Math.max(0.4, normalized * 0.95)
      },
    })

    velocityLayer.addTo(map)
    velocityLayerRef.current = velocityLayer
  }, [velocityReady])

  useEffect(() => {
    velocityDataRef.current = clampVelocityData(collection.mapField.velocityData)
    if (!velocityReady) return
    mountVelocityLayer()
  }, [collection.mapField.velocityData, mountVelocityLayer, velocityReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !velocityReady) return

    const refreshAfterInteraction = () => {
      visibleSpotUpdater()
      if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current)
      }
      interactionTimerRef.current = window.setTimeout(() => {
        mountVelocityLayer()
      }, 100)
    }

    const showPointData = (event: L.LeafletMouseEvent) => {
      const nearestPoint = nearestFieldPoint(event.latlng.lat, event.latlng.lng)
      if (!nearestPoint) return

      L.popup({ maxWidth: 260 })
        .setLatLng(event.latlng)
        .setContent(
          `<strong>Wave field</strong><br/>${nearestPoint.latitude.toFixed(2)}, ${nearestPoint.longitude.toFixed(2)}<br/>${nearestPoint.waveHeight.toFixed(1)}m @ ${nearestPoint.wavePeriod.toFixed(1)}s<br/>Wave dir ${nearestPoint.waveDirection.toFixed(0)}° · Wind ${nearestPoint.windSpeed.toFixed(0)} km/h ${nearestPoint.windDirection.toFixed(0)}°`,
        )
        .openOn(map)
    }

    map.on('zoomend', refreshAfterInteraction)
    map.on('moveend', refreshAfterInteraction)
    map.on('click', showPointData)

    return () => {
      map.off('zoomend', refreshAfterInteraction)
      map.off('moveend', refreshAfterInteraction)
      map.off('click', showPointData)
      if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current)
        interactionTimerRef.current = null
      }
    }
  }, [mountVelocityLayer, nearestFieldPoint, velocityReady, visibleSpotUpdater])

  useEffect(() => {
    const layer = markersLayerRef.current
    const webcamLayer = webcamLayerRef.current
    if (!layer || !webcamLayer) return

    layer.clearLayers()
    webcamLayer.clearLayers()

    collection.spots.forEach((forecast) => {
      const isSelected = forecast.spot.id === selectedSpotId
      const marker = L.circleMarker([forecast.spot.latitude, forecast.spot.longitude], {
        pane: 'spotsPane',
        radius: isSelected ? 7 : 4,
        weight: isSelected ? 2 : 1,
        color: isSelected ? '#f8fbff' : '#76d6ff',
        fillColor:
          forecast.current.score >= 65
            ? '#00e0a4'
            : forecast.current.score >= 45
              ? '#76d6ff'
              : '#f2a65a',
        fillOpacity: 0.92,
      })
      const webcamLine = forecast.spot.webcamUrl
        ? `<br/><a href="${forecast.spot.webcamUrl}" target="_blank" rel="noreferrer">Open public webcam</a>`
        : ''
      marker.bindPopup(
        `<strong>${forecast.spot.name}</strong><br/>${forecast.spot.region}, ${forecast.spot.country}<br/>Score ${forecast.current.score} · ${forecast.current.waveHeight.toFixed(1)}m @ ${forecast.current.wavePeriod.toFixed(1)}s${webcamLine}`,
      )
      marker.on('click', () => onSelectSpot(forecast.spot.id))
      marker.addTo(layer)

      if (forecast.spot.webcamUrl) {
        const webcamMarker = L.marker([forecast.spot.latitude, forecast.spot.longitude], {
          pane: 'webcamPane',
          icon: webcamIcon,
          title: `${forecast.spot.name} webcam`,
        })
        webcamMarker.bindPopup(
          `<strong>${forecast.spot.name} webcam</strong><br/><a href="${forecast.spot.webcamUrl}" target="_blank" rel="noreferrer">Open public webcam</a>`,
        )
        webcamMarker.on('click', () => onSelectSpot(forecast.spot.id))
        webcamMarker.addTo(webcamLayer)
      }
    })

    visibleSpotUpdater()
  }, [collection.spots, onSelectSpot, selectedSpotId, visibleSpotUpdater])

  const totalSpots = collection.spots.length
  const best = [...collection.spots].sort((a, b) => b.current.score - a.current.score)[0]

  return (
    <section className="panel world-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">World map</p>
          <h2>Wave flow particles</h2>
        </div>
        <span className="muted-text">
          {totalSpots} spots · {webcamCount} webcam pins
          {!velocityReady ? ' · loading velocity' : ''}
        </span>
      </div>

      <div className="world-panel-meta">
        <span>Pan the map to discover spots in-view. Webcam spots get 📷 markers.</span>
        <span>Best now: {best.spot.name} ({best.current.score})</span>
      </div>

      <div className="world-map-wrap">
        <div ref={mapElementRef} className="world-map" />
      </div>

      <div className="world-legend">
        <span><i className="legend-dot epic" /> 60+ score</span>
        <span><i className="legend-dot fun" /> 45–59 score</span>
        <span><i className="legend-dot fair" /> under 45</span>
        <span><i className="legend-camera" /> webcam</span>
      </div>
    </section>
  )
}
