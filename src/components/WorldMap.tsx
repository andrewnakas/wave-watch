import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { ForecastCollection, VelocityRecord } from '../types'

type Props = {
  collection: ForecastCollection
  selectedSpotId: string
  onSelectSpot: (spotId: string) => void
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

export function WorldMap({ collection, selectedSpotId, onSelectSpot }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const markersLayerRef = useRef<L.LayerGroup | null>(null)
  const velocityLayerRef = useRef<LeafletVelocityLayer | null>(null)
  const [velocityReady, setVelocityReady] = useState(false)

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
      preferCanvas: true,
    }).setView([18, 0], 2)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      noWrap: false,
    }).addTo(map)

    markersLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    return () => {
      cleanupVelocityLayer(map, velocityLayerRef.current)
      velocityLayerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !velocityReady || !velocityLeaflet.velocityLayer) return

    cleanupVelocityLayer(map, velocityLayerRef.current)
    velocityLayerRef.current = null

    const filteredVelocityData = clampVelocityData(collection.mapField.velocityData)
    const velocityLayer = velocityLeaflet.velocityLayer({
      data: filteredVelocityData,
      displayValues: false,
      velocityScale: 0.0045,
      opacity: 0.9,
      maxVelocity: 8,
      minVelocity: 0.05,
      particleMultiplier: 0.004,
      lineWidth: 2.6,
      colorScale: ['#16324f', '#1b4d70', '#23769c', '#2ca7d8', '#83d9ea'],
      frameRate: 20,
      particleAge: 42,
      fadeOpacity: 0.972,
      animationDuration: 0,
      bounds: [[-60, -180], [60, 180]],
      wrapX: false,
      noWrap: true,
      minZoom: 2,
      particleReduction: 0.85,
      dynamicOpacity: true,
      velocityOpacity: (velocity: number, u?: number, v?: number) => {
        const magnitude =
          u !== undefined && v !== undefined
            ? Math.sqrt(u * u + v * v)
            : velocity

        if (magnitude > 10) return 0

        const normalized = Math.min(magnitude / 6, 1)
        return Math.max(0.45, normalized * 0.9)
      },
    })

    const removeForInteraction = () => {
      if (!velocityLayerRef.current) return
      if (map.hasLayer(velocityLayerRef.current)) {
        cleanupVelocityLayer(map, velocityLayerRef.current)
      }
    }

    const restoreAfterInteraction = () => {
      if (!velocityLayerRef.current) return
      if (!map.hasLayer(velocityLayerRef.current)) {
        velocityLayerRef.current.addTo(map)
      }
    }

    map.on('zoomstart', removeForInteraction)
    map.on('movestart', removeForInteraction)
    map.on('zoomend', restoreAfterInteraction)
    map.on('moveend', restoreAfterInteraction)

    velocityLayer.addTo(map)
    velocityLayerRef.current = velocityLayer

    return () => {
      map.off('zoomstart', removeForInteraction)
      map.off('movestart', removeForInteraction)
      map.off('zoomend', restoreAfterInteraction)
      map.off('moveend', restoreAfterInteraction)
      cleanupVelocityLayer(map, velocityLayer)
      if (velocityLayerRef.current === velocityLayer) {
        velocityLayerRef.current = null
      }
    }
  }, [collection.mapField.velocityData, velocityReady])

  useEffect(() => {
    const layer = markersLayerRef.current
    if (!layer) return

    layer.clearLayers()

    collection.spots.forEach((forecast) => {
      const isSelected = forecast.spot.id === selectedSpotId
      const marker = L.circleMarker([forecast.spot.latitude, forecast.spot.longitude], {
        radius: isSelected ? 8 : 5,
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
        ? `<br/><a href="${forecast.spot.webcamUrl}" target="_blank" rel="noreferrer">Public webcam</a>`
        : ''
      marker.bindPopup(
        `<strong>${forecast.spot.name}</strong><br/>${forecast.spot.region}, ${forecast.spot.country}<br/>Score ${forecast.current.score} · ${forecast.current.waveHeight.toFixed(1)}m @ ${forecast.current.wavePeriod.toFixed(1)}s${webcamLine}`,
      )
      marker.on('click', () => onSelectSpot(forecast.spot.id))
      marker.addTo(layer)
    })
  }, [collection.spots, onSelectSpot, selectedSpotId])

  const totalSpots = collection.spots.length
  const withWebcams = collection.spots.filter((spot) => Boolean(spot.spot.webcamUrl)).length
  const best = [...collection.spots].sort((a, b) => b.current.score - a.current.score)[0]

  return (
    <section className="panel world-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">World map</p>
          <h2>Wave flow particles</h2>
        </div>
        <span className="muted-text">
          {totalSpots} spots · {withWebcams} webcam links
          {!velocityReady ? ' · loading velocity' : ''}
        </span>
      </div>

      <div className="world-panel-meta">
        <span>Tree60-style velocity concept, tuned slower and thicker for swell flow.</span>
        <span>Best now: {best.spot.name} ({best.current.score})</span>
      </div>

      <div className="world-map-wrap">
        <div ref={mapElementRef} className="world-map" />
      </div>

      <div className="world-legend">
        <span><i className="legend-dot epic" /> 60+ score</span>
        <span><i className="legend-dot fun" /> 45–59 score</span>
        <span><i className="legend-dot fair" /> under 45</span>
      </div>
    </section>
  )
}
