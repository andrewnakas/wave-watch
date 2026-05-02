import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-velocity'
import type { ForecastCollection } from '../types'

type Props = {
  collection: ForecastCollection
  selectedSpotId: string
  onSelectSpot: (spotId: string) => void
}

type LeafletVelocityLayer = L.Layer & {
  setData?: (data: unknown) => void
}

type LeafletWithVelocity = typeof L & {
  velocityLayer?: (options: Record<string, unknown>) => LeafletVelocityLayer
}

const velocityLeaflet = L as LeafletWithVelocity

export function WorldMap({ collection, selectedSpotId, onSelectSpot }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const markersLayerRef = useRef<L.LayerGroup | null>(null)
  const velocityLayerRef = useRef<LeafletVelocityLayer | null>(null)

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return

    const map = L.map(mapElementRef.current, {
      worldCopyJump: true,
      zoomControl: true,
      minZoom: 2,
    }).setView([18, 0], 2)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    markersLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !velocityLeaflet.velocityLayer) return

    if (velocityLayerRef.current) {
      map.removeLayer(velocityLayerRef.current)
      velocityLayerRef.current = null
    }

    const velocityLayer = velocityLeaflet.velocityLayer({
      data: collection.mapField.velocityData,
      displayValues: true,
      displayOptions: {
        velocityType: 'Wave energy flow',
        position: 'bottomleft',
        emptyString: 'No wave flow data',
        angleConvention: 'bearingCW',
        showCardinal: true,
        speedUnit: 'm/s',
        directionString: 'Direction',
        speedString: 'Flow',
      },
      minVelocity: 0,
      maxVelocity: 8,
      velocityScale: 0.008,
      particleAge: 90,
      particleMultiplier: 280,
      frameRate: 20,
      lineWidth: 1.6,
      opacity: 0.75,
      colorScale: ['#16324f', '#1f5f8b', '#2ca7d8', '#48d1cc', '#9bf6ff'],
    })

    velocityLayer.addTo(map)
    velocityLayerRef.current = velocityLayer
  }, [collection.mapField.velocityData])

  useEffect(() => {
    const map = mapRef.current
    const layer = markersLayerRef.current
    if (!map || !layer) return

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
          <h2>Windy-style wave particles</h2>
        </div>
        <span className="muted-text">{totalSpots} spots · {withWebcams} webcam links</span>
      </div>

      <div className="world-panel-meta">
        <span>Leaflet Velocity is driving the particle field from the generated wave-flow grid.</span>
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
