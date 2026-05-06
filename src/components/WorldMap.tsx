import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { MapDataset, MapFieldPoint, Spot, SpotSummary, VelocityRecord } from '../types'

type Props = {
  collection: MapDataset
  spotCatalog: Spot[]
  summaryById: Map<string, SpotSummary>
  selectedSpotId: string
  onSelectSpot: (spotId: string) => void
  onSelectPoint?: (latitude: number, longitude: number) => void
  onVisibleSpotIdsChange?: (spotIds: string[]) => void
}

type LeafletVelocityLayer = L.Layer & {
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
  const nextU = [...uRecord.data]
  const nextV = [...vRecord.data]
  for (let index = 0; index < nextU.length; index += 1) {
    const u = nextU[index] ?? 0
    const v = nextV[index] ?? 0
    const magnitude = Math.sqrt(u * u + v * v)
    if (magnitude > 14) {
      nextU[index] = 0
      nextV[index] = 0
    } else if (magnitude > 8) {
      const scale = 8 / magnitude
      nextU[index] = Number((u * scale).toFixed(3))
      nextV[index] = Number((v * scale).toFixed(3))
    }
  }
  return [{ ...uRecord, data: nextU }, { ...vRecord, data: nextV }]
}

const cleanupVelocityLayer = (map: L.Map | null, layer: LeafletVelocityLayer | null) => {
  if (!map || !layer) return
  try {
    map.removeLayer(layer)
  } catch {
    // Ignore double-cleanup errors from Leaflet during remounts.
  }
  if (layer._container) layer._container.remove()
}

const distanceSquared = (spot: Spot, latitude: number, longitude: number) => {
  const latDelta = spot.latitude - latitude
  const lonDelta = spot.longitude - longitude
  return latDelta * latDelta + lonDelta * lonDelta
}

const pointDistanceSquared = (point: MapFieldPoint, latitude: number, longitude: number) => {
  const latDelta = point.latitude - latitude
  const lonDelta = point.longitude - longitude
  return latDelta * latDelta + lonDelta * lonDelta
}

export function WorldMap({
  collection,
  spotCatalog,
  summaryById,
  selectedSpotId,
  onSelectSpot,
  onSelectPoint,
  onVisibleSpotIdsChange,
}: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const markersLayerRef = useRef<L.LayerGroup | null>(null)
  const webcamLayerRef = useRef<L.LayerGroup | null>(null)
  const velocityLayerRef = useRef<LeafletVelocityLayer | null>(null)
  const velocityDataRef = useRef<VelocityRecord[]>([])
  const interactionTimerRef = useRef<number | null>(null)
  const [velocityReady, setVelocityReady] = useState(false)
  const [renderBounds, setRenderBounds] = useState<L.LatLngBounds | null>(null)

  const webcamCount = useMemo(() => spotCatalog.filter((spot) => Boolean(spot.webcamUrl)).length, [spotCatalog])

  const nearestFieldPoint = useCallback(
    (latitude: number, longitude: number) => {
      if (!collection.mapField.points.length) return null
      return collection.mapField.points.reduce((best, point) =>
        pointDistanceSquared(point, latitude, longitude) < pointDistanceSquared(best, latitude, longitude) ? point : best,
      )
    },
    [collection.mapField.points],
  )

  const visibleSpotUpdater = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const bounds = map.getBounds()
    setRenderBounds(bounds.pad(0.2))
    if (!onVisibleSpotIdsChange) return
    const center = map.getCenter()
    const visibleIds = spotCatalog
      .filter((spot) => bounds.pad(0.12).contains([spot.latitude, spot.longitude]))
      .sort((a, b) => distanceSquared(a, center.lat, center.lng) - distanceSquared(b, center.lat, center.lng))
      .map((spot) => spot.id)
    onVisibleSpotIdsChange(visibleIds)
  }, [onVisibleSpotIdsChange, spotCatalog])

  useEffect(() => {
    let active = true
    const initVelocity = async () => {
      ;(globalThis as { L?: typeof L }).L = L
      try {
        await import('leaflet-velocity')
      } catch {
        // Keep rendering the map even if the particle plugin fails to load.
      }
      if (active) setVelocityReady(Boolean((L as LeafletWithVelocity).velocityLayer))
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

    mapRef.current = map
    visibleSpotUpdater()

    return () => {
      cleanupVelocityLayer(map, velocityLayerRef.current)
      velocityLayerRef.current = null
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
    const particleMultiplier = Math.min(0.008, 0.0015 + Math.max(zoom - 2, 0) * 0.0009)
    const lineWidth = Math.min(2.4, 1.2 + Math.max(zoom - 2, 0) * 0.14)
    const particleAge = Math.max(16, 28 - Math.max(zoom - 2, 0))

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
      frameRate: 16,
      particleAge,
      fadeOpacity: 0.97,
      animationDuration: 0,
      bounds: [[-70, -180], [70, 180]],
      wrapX: false,
      noWrap: true,
      minZoom: 0,
      maxZoom: 12,
      particleReduction: 1,
    })

    velocityLayer.addTo(map)
    velocityLayerRef.current = velocityLayer
  }, [velocityReady])

  useEffect(() => {
    velocityDataRef.current = clampVelocityData(collection.mapField.velocityData)
    if (velocityReady) mountVelocityLayer()
  }, [collection.mapField.velocityData, mountVelocityLayer, velocityReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !velocityReady) return
    const handleMoveEnd = () => {
      visibleSpotUpdater()
    }
    const handleZoomEnd = () => {
      visibleSpotUpdater()
      if (interactionTimerRef.current !== null) window.clearTimeout(interactionTimerRef.current)
      interactionTimerRef.current = window.setTimeout(() => mountVelocityLayer(), 120)
    }
    const showPointData = (event: L.LeafletMouseEvent) => {
      const nearestPoint = nearestFieldPoint(event.latlng.lat, event.latlng.lng)
      onSelectPoint?.(event.latlng.lat, event.latlng.lng)
      if (!nearestPoint) return
      L.popup({ maxWidth: 260 })
        .setLatLng(event.latlng)
        .setContent(
          `<strong>Wave field</strong><br/>${nearestPoint.latitude.toFixed(2)}, ${nearestPoint.longitude.toFixed(2)}<br/>${nearestPoint.waveHeight.toFixed(1)}m @ ${nearestPoint.wavePeriod.toFixed(1)}s<br/>Wave dir ${nearestPoint.waveDirection.toFixed(0)}° · Wind ${nearestPoint.windSpeed.toFixed(0)} km/h ${nearestPoint.windDirection.toFixed(0)}°<br/>Nearby spots now sort by popularity.`,
        )
        .openOn(map)
    }
    map.on('zoomend', handleZoomEnd)
    map.on('moveend', handleMoveEnd)
    map.on('click', showPointData)
    return () => {
      map.off('zoomend', handleZoomEnd)
      map.off('moveend', handleMoveEnd)
      map.off('click', showPointData)
      if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current)
        interactionTimerRef.current = null
      }
    }
  }, [mountVelocityLayer, nearestFieldPoint, onSelectPoint, velocityReady, visibleSpotUpdater])

  useEffect(() => {
    const layer = markersLayerRef.current
    const webcamLayer = webcamLayerRef.current
    if (!layer || !webcamLayer) return

    layer.clearLayers()
    webcamLayer.clearLayers()

    const spotsToRender = renderBounds
      ? spotCatalog.filter((spot) => spot.id === selectedSpotId || renderBounds.contains([spot.latitude, spot.longitude]))
      : spotCatalog.filter((spot) => spot.id === selectedSpotId).concat(spotCatalog.slice(0, 300))

    spotsToRender.forEach((spot) => {
      const summary = summaryById.get(spot.id)
      const isSelected = spot.id === selectedSpotId
      const webcamLine = spot.webcamUrl ? `<br/><a href="${spot.webcamUrl}" target="_blank" rel="noreferrer">Open public webcam</a>` : ''
      const popup = summary
        ? `<strong>${spot.name}</strong><br/>${spot.region}, ${spot.country}<br/>Score ${summary.current.score} · ${summary.current.waveHeight.toFixed(1)}m @ ${summary.current.wavePeriod.toFixed(1)}s<br/>Tide ${summary.current.seaLevelHeight?.toFixed(2) ?? '--'}m ${summary.current.tideTrend}${webcamLine}`
        : `<strong>${spot.name}</strong><br/>${spot.region}, ${spot.country}<br/>Click for live detail${webcamLine}`
      const markerColor = summary
        ? summary.current.score >= 65
          ? '#00e0a4'
          : summary.current.score >= 45
            ? '#76d6ff'
            : '#f2a65a'
        : '#6d7f93'

      const hitArea = L.circleMarker([spot.latitude, spot.longitude], {
        pane: 'spotsPane',
        radius: isSelected ? 16 : 13,
        weight: 0,
        opacity: 0,
        fillOpacity: 0,
      })
      hitArea.bindPopup(popup)
      hitArea.on('click', () => onSelectSpot(spot.id))
      hitArea.addTo(layer)

      const marker = L.circleMarker([spot.latitude, spot.longitude], {
        pane: 'spotsPane',
        interactive: false,
        radius: isSelected ? 8.5 : summary ? 5.6 : 4.4,
        weight: isSelected ? 2.2 : 1.2,
        color: isSelected ? '#f8fbff' : summary ? '#76d6ff' : 'rgba(160, 188, 214, 0.72)',
        fillColor: markerColor,
        fillOpacity: summary ? 0.95 : 0.55,
      })
      marker.addTo(layer)

      if (spot.webcamUrl) {
        const webcamMarker = L.marker([spot.latitude, spot.longitude], {
          pane: 'webcamPane',
          icon: webcamIcon,
          title: `${spot.name} webcam`,
        })
        webcamMarker.bindPopup(`<strong>${spot.name} webcam</strong><br/><a href="${spot.webcamUrl}" target="_blank" rel="noreferrer">Open public webcam</a>`)
        webcamMarker.on('click', () => onSelectSpot(spot.id))
        webcamMarker.addTo(webcamLayer)
      }
    })
  }, [onSelectSpot, renderBounds, selectedSpotId, spotCatalog, summaryById, visibleSpotUpdater])

  const best = [...summaryById.values()].sort((a, b) => b.current.score - a.current.score)[0]

  return (
    <section className="panel world-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">World map</p>
          <h2>Wave flow particles</h2>
        </div>
        <span className="muted-text">
          {spotCatalog.length.toLocaleString()} spots · {webcamCount} webcam pins
          {!velocityReady ? ' · loading live wave layer' : ''}
        </span>
      </div>

      <div className="world-panel-meta">
        <span>Click any coastline to center the nearby list around that point, or click a break for full detail.</span>
        <span>Best now: {best ? `${best.spot.name} (${best.current.score})` : 'loading'}</span>
      </div>

      <div className="world-map-wrap">
        <div ref={mapElementRef} className="world-map" />
      </div>

      <div className="world-legend">
        <span><i className="legend-dot epic" /> excellent</span>
        <span><i className="legend-dot fun" /> decent</span>
        <span><i className="legend-dot fair" /> poor</span>
        <span><i className="legend-camera" /> webcam</span>
      </div>
    </section>
  )
}
