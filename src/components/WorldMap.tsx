import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { ForecastCollection } from '../types'

type Props = {
  collection: ForecastCollection
  selectedSpotId: string
  onSelectSpot: (spotId: string) => void
}

type Particle = {
  x: number
  y: number
  life: number
  maxLife: number
}

const directionToVector = (direction: number, magnitude: number) => {
  const radians = ((direction + 180) * Math.PI) / 180
  return {
    vx: Math.sin(radians) * magnitude,
    vy: -Math.cos(radians) * magnitude,
  }
}

export function WorldMap({ collection, selectedSpotId, onSelectSpot }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const markersLayerRef = useRef<L.LayerGroup | null>(null)
  const animationFrameRef = useRef<number | null>(null)

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

    const resize = () => {
      const canvas = overlayRef.current
      const container = map.getContainer()
      if (!canvas) return
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
    }

    resize()
    map.on('resize move zoom', resize)

    return () => {
      map.off('resize move zoom', resize)
      map.remove()
      mapRef.current = null
    }
  }, [])

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
        fillColor: forecast.current.score >= 65 ? '#00e0a4' : forecast.current.score >= 45 ? '#76d6ff' : '#f2a65a',
        fillOpacity: 0.9,
      })
      marker.bindPopup(
        `<strong>${forecast.spot.name}</strong><br/>${forecast.spot.region}, ${forecast.spot.country}<br/>Score ${forecast.current.score} · ${forecast.current.waveHeight.toFixed(1)}m @ ${forecast.current.wavePeriod.toFixed(1)}s`,
      )
      marker.on('click', () => onSelectSpot(forecast.spot.id))
      marker.addTo(layer)
    })
  }, [collection.spots, onSelectSpot, selectedSpotId])

  useEffect(() => {
    const map = mapRef.current
    const canvas = overlayRef.current
    if (!map || !canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const particles: Particle[] = Array.from({ length: 260 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      life: Math.random() * 120,
      maxLife: 80 + Math.random() * 120,
    }))

    const points = collection.mapField.points

    const lookupNearest = (lat: number, lon: number) => {
      let best = points[0]
      let bestDistance = Number.POSITIVE_INFINITY
      for (const point of points) {
        const distance = (point.latitude - lat) ** 2 + (point.longitude - lon) ** 2
        if (distance < bestDistance) {
          best = point
          bestDistance = distance
        }
      }
      return best
    }

    const resetParticle = (particle: Particle) => {
      particle.x = Math.random() * canvas.width
      particle.y = Math.random() * canvas.height
      particle.life = 0
      particle.maxLife = 70 + Math.random() * 110
    }

    const frame = () => {
      context.fillStyle = 'rgba(5, 12, 22, 0.08)'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.lineWidth = 1.1

      for (const particle of particles) {
        const start = L.point(particle.x, particle.y)
        const latLng = map.containerPointToLatLng(start)
        const nearest = lookupNearest(latLng.lat, latLng.lng)
        const intensity = Math.max(nearest.waveHeight, nearest.windSpeed / 20)
        const speed = 0.4 + intensity * 0.9
        const { vx, vy } = directionToVector(nearest.waveDirection, speed)
        const nextX = particle.x + vx
        const nextY = particle.y + vy
        const alpha = Math.max(0.14, Math.min(0.9, nearest.waveHeight / 4 + 0.15))

        context.strokeStyle = `rgba(118, 214, 255, ${alpha})`
        context.beginPath()
        context.moveTo(particle.x, particle.y)
        context.lineTo(nextX, nextY)
        context.stroke()

        particle.x = nextX
        particle.y = nextY
        particle.life += 1

        if (
          particle.life > particle.maxLife ||
          nextX < -20 ||
          nextY < -20 ||
          nextX > canvas.width + 20 ||
          nextY > canvas.height + 20
        ) {
          resetParticle(particle)
        }
      }

      animationFrameRef.current = window.requestAnimationFrame(frame)
    }

    context.clearRect(0, 0, canvas.width, canvas.height)
    frame()

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [collection.mapField.points])

  const totalSpots = collection.spots.length
  const goodSpots = collection.spots.filter((spot) => spot.current.score >= 60).length
  const best = [...collection.spots].sort((a, b) => b.current.score - a.current.score)[0]

  return (
    <section className="panel world-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">World map</p>
          <h2>Particle swell field</h2>
        </div>
        <span className="muted-text">{totalSpots} spots · {goodSpots} looking good</span>
      </div>

      <div className="world-panel-meta">
        <span>Particles follow blended wave direction from the global field.</span>
        <span>Best now: {best.spot.name} ({best.current.score})</span>
      </div>

      <div className="world-map-wrap">
        <div ref={mapElementRef} className="world-map" />
        <canvas ref={overlayRef} className="world-map-overlay" />
      </div>

      <div className="world-legend">
        <span><i className="legend-dot epic" /> 60+ score</span>
        <span><i className="legend-dot fun" /> 45–59 score</span>
        <span><i className="legend-dot fair" /> under 45</span>
      </div>
    </section>
  )
}
