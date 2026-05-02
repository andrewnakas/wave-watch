import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { WorldMap } from './components/WorldMap'
import {
  describeScore,
  findForecastBySpot,
  formatDirection,
  formatHour,
  loadForecastCollection,
} from './lib/forecast'
import type { ForecastCollection, ForecastPayload } from './types'

const FAVORITES_KEY = 'wave-watch-favorites'

const readFavorites = () => {
  if (typeof window === 'undefined') return [] as string[]
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

const saveFavorites = (favorites: string[]) => {
  window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
}

function App() {
  const [selectedSpotId, setSelectedSpotId] = useState('')
  const [visibleSpotIds, setVisibleSpotIds] = useState<string[]>([])
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites())
  const [collection, setCollection] = useState<ForecastCollection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    loadForecastCollection()
      .then((payload) => {
        if (!active) return
        setCollection(payload)
        setSelectedSpotId((current) => current || payload.spots[0]?.spot.id || '')
      })
      .catch((caught) => {
        if (!active) return
        setError(caught instanceof Error ? caught.message : 'Could not load generated forecast data.')
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const forecastById = useMemo(() => {
    if (!collection) return new Map<string, ForecastPayload>()
    return new Map(collection.spots.map((forecast) => [forecast.spot.id, forecast]))
  }, [collection])

  const activeSpotId = useMemo(() => {
    if (!collection?.spots.length) return selectedSpotId
    return selectedSpotId && collection.spots.some((spot) => spot.spot.id === selectedSpotId)
      ? selectedSpotId
      : collection.spots[0].spot.id
  }, [collection, selectedSpotId])

  const forecast = useMemo<ForecastPayload | null>(() => {
    if (!collection || !activeSpotId) return null
    return findForecastBySpot(collection, activeSpotId)
  }, [activeSpotId, collection])

  const selectedSpot = forecast?.spot ?? collection?.spots[0]?.spot ?? null

  const toggleFavorite = (spotId: string) => {
    setFavorites((current) => {
      const next = current.includes(spotId)
        ? current.filter((id) => id !== spotId)
        : [...current, spotId]
      saveFavorites(next)
      return next
    })
  }

  const favoriteSpots = useMemo(
    () => collection?.spots.filter((spot) => favorites.includes(spot.spot.id)) ?? [],
    [collection, favorites],
  )

  const spotList = useMemo(() => {
    if (!collection) return [] as ForecastPayload[]

    const visible = visibleSpotIds
      .map((id) => forecastById.get(id))
      .filter((spot): spot is ForecastPayload => Boolean(spot))

    if (visible.length) return visible

    return [...collection.spots]
      .sort((a, b) => b.current.score - a.current.score)
      .slice(0, 150)
  }, [collection, forecastById, visibleSpotIds])

  const chartPoints = useMemo(() => {
    const hours = forecast?.hourly.slice(0, 24) ?? []
    if (!hours.length) return ''

    return hours
      .map((point, index) => {
        const x = (index / Math.max(hours.length - 1, 1)) * 100
        const y = 100 - Math.min(point.waveHeight / 6, 1) * 100
        return `${x},${y}`
      })
      .join(' ')
  }, [forecast])

  const generatedAtText = collection
    ? new Date(collection.generatedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '--'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Wave Watch</p>
          <h1>14-day wave guidance from multiple forecast systems.</h1>
        </div>
        <div className="topbar-meta">
          <span className="status-pill">Generated static dataset · {generatedAtText}</span>
          <a className="ghost-button" href={`${import.meta.env.BASE_URL}data/forecast-data.json`} target="_blank" rel="noreferrer">
            View raw data
          </a>
        </div>
      </header>

      <main className="app-main">
        {collection ? (
          <WorldMap
            collection={collection}
            selectedSpotId={activeSpotId}
            onSelectSpot={setSelectedSpotId}
            onVisibleSpotIdsChange={setVisibleSpotIds}
          />
        ) : null}

        <div className="layout-grid">
          <aside className="panel sidebar-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Spots</p>
                <h2>Find them on the map</h2>
              </div>
              <span className="muted-text">
                {collection?.spots.length ?? 0} total · {spotList.length} in view · {favoriteSpots.length} saved
              </span>
            </div>

            <div className="spot-list">
              {spotList.map((spotForecast) => {
                const spot = spotForecast.spot
                const isFavorite = favorites.includes(spot.id)
                const isActive = spot.id === activeSpotId
                return (
                  <article
                    key={spot.id}
                    className={`spot-card ${isActive ? 'active' : ''}`}
                    onClick={() => setSelectedSpotId(spot.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedSpotId(spot.id)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <div className="spot-card-title-row">
                        <h3>{spot.name}</h3>
                        <div className="spot-card-actions">
                          {spot.webcamUrl ? <span className="mini-pill">cam</span> : null}
                          <button
                            type="button"
                            className={`favorite-button ${isFavorite ? 'active' : ''}`}
                            aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleFavorite(spot.id)
                            }}
                          >
                            ★
                          </button>
                        </div>
                      </div>
                      <p>
                        {spot.region}, {spot.country}
                      </p>
                    </div>
                    <div className="spot-card-tags">
                      <span>score {spotForecast.current.score}</span>
                      <span>{spotForecast.current.waveHeight.toFixed(1)}m</span>
                      <span>{spotForecast.current.wavePeriod.toFixed(1)}s</span>
                    </div>
                  </article>
                )
              })}
            </div>
          </aside>

          <section className="hero-column">
            <section className="panel hero-panel">
              <div className="hero-copy">
                <p className="eyebrow">Now watching</p>
                <div className="hero-title-row">
                  <div>
                    <h2>{selectedSpot?.name ?? 'Loading'}</h2>
                    <p>
                      {selectedSpot ? `${selectedSpot.region}, ${selectedSpot.country}` : 'Waiting on map selection'}
                    </p>
                  </div>
                  <div className="score-badge">
                    <strong>{forecast?.current.score ?? '--'}</strong>
                    <span>{forecast ? describeScore(forecast.current.score) : 'Loading'}</span>
                  </div>
                </div>
                <p className="hero-summary">
                  {selectedSpot
                    ? `Best tide: ${selectedSpot.tideWindow}. Best board: ${selectedSpot.boardHint}. Ideal swell ${selectedSpot.idealSwellMin}–${selectedSpot.idealSwellMax}m @ ${selectedSpot.idealPeriodMin}+s.`
                    : 'Loading spot details.'}
                </p>
                {selectedSpot?.webcamUrl ? (
                  <a className="ghost-button inline-button" href={selectedSpot.webcamUrl} target="_blank" rel="noreferrer">
                    Open public webcam
                  </a>
                ) : null}
              </div>

              <div className="stat-grid">
                <article className="stat-card">
                  <span>Wave height</span>
                  <strong>{forecast ? `${forecast.current.waveHeight.toFixed(1)}m` : '--'}</strong>
                  <p>Blend of {forecast?.modelBlend.waveModels.length ?? 0} wave models</p>
                </article>
                <article className="stat-card">
                  <span>Wave period</span>
                  <strong>{forecast ? `${forecast.current.wavePeriod.toFixed(1)}s` : '--'}</strong>
                  <p>Long-period energy gets priority</p>
                </article>
                <article className="stat-card">
                  <span>Wind</span>
                  <strong>
                    {forecast
                      ? `${forecast.current.windSpeed.toFixed(0)} km/h ${formatDirection(forecast.current.windDirection)}`
                      : '--'}
                  </strong>
                  <p>Weather blend tracks offshore alignment</p>
                </article>
                <article className="stat-card accent-card">
                  <span>Next best window</span>
                  <strong>{forecast ? formatHour(forecast.nextBestWindow.time) : '--'}</strong>
                  <p>
                    {forecast
                      ? `${forecast.nextBestWindow.waveHeight.toFixed(1)}m · ${forecast.nextBestWindow.wavePeriod.toFixed(1)}s · ${forecast.nextBestWindow.confidence}% confidence`
                      : 'Scanning...'}
                  </p>
                </article>
              </div>
            </section>

            <section className="panel chart-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">24-hour outlook</p>
                  <h2>Wave pulse</h2>
                </div>
                <span className="muted-text">
                  {forecast ? `${forecast.current.confidence}% confidence now` : 'Waiting on data'}
                </span>
              </div>

              {loading ? (
                <div className="empty-state">Loading generated forecast package…</div>
              ) : error ? (
                <div className="empty-state">{error}</div>
              ) : forecast ? (
                <>
                  <div className="line-chart-wrap">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="line-chart">
                      <polyline
                        fill="none"
                        stroke="rgba(116, 214, 255, 0.95)"
                        strokeWidth="2"
                        points={chartPoints}
                      />
                    </svg>
                  </div>
                  <div className="hour-row">
                    {forecast.hourly.slice(0, 8).map((point) => (
                      <article className="hour-card" key={point.time}>
                        <p>{formatHour(point.time)}</p>
                        <strong>{point.waveHeight.toFixed(1)}m</strong>
                        <span>{point.wavePeriod.toFixed(1)}s period</span>
                        <small>{point.confidence}% conf · spread {point.modelSpread.toFixed(1)}</small>
                      </article>
                    ))}
                  </div>
                </>
              ) : null}
            </section>

            <section className="panel daily-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">14-day forecast</p>
                  <h2>Pick your mission</h2>
                </div>
              </div>
              <div className="daily-grid daily-grid-14">
                {forecast?.daily.map((day) => (
                  <article className="daily-card" key={day.date}>
                    <div>
                      <p>{day.label}</p>
                      <strong>{day.maxWaveHeight.toFixed(1)}m</strong>
                    </div>
                    <ul>
                      <li>{day.minWaveHeight.toFixed(1)}–{day.maxWaveHeight.toFixed(1)}m range</li>
                      <li>{day.avgWavePeriod.toFixed(1)}s avg period</li>
                      <li>{day.avgWindSpeed.toFixed(0)} km/h wind</li>
                      <li>Best {day.bestScore} at {day.bestHour}</li>
                      <li>{day.confidence.toFixed(0)}% confidence</li>
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          </section>

          <aside className="panel insight-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Model stack</p>
                <h2>Forecast notes</h2>
              </div>
            </div>

            <div className="insight-stack">
              <article className="insight-card emphasis">
                <span>Wave models</span>
                <strong>{forecast?.modelBlend.waveModels.join(', ') ?? '--'}</strong>
                <p>Consensus blend instead of a single raw run.</p>
              </article>
              <article className="insight-card">
                <span>Weather models</span>
                <strong>{forecast?.modelBlend.weatherModels.join(', ') ?? '--'}</strong>
                <p>Wind drives the surf score as much as swell does.</p>
              </article>
              <article className="insight-card">
                <span>Buoy check</span>
                <strong>
                  {forecast?.buoy?.waveHeight !== null && forecast?.buoy?.waveHeight !== undefined
                    ? `${forecast.buoy.waveHeight.toFixed(1)}m @ ${forecast.buoy.dominantPeriod?.toFixed(0) ?? '--'}s`
                    : 'No buoy wired'}
                </strong>
                <p>
                  {forecast?.buoy
                    ? `${forecast.buoy.stationName ?? forecast.buoy.stationId} · observed ${new Date(forecast.buoy.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : 'Map view drives the spot list now so you can browse by region instead of scrolling a bad global slab.'}
                </p>
              </article>
              <article className="insight-card">
                <span>Coverage</span>
                <strong>{collection?.spots.length ?? 0} spots · {collection?.spots.filter((spot) => spot.spot.webcamUrl).length ?? 0} cams</strong>
                <p>Public webcam coverage is still partial, but now every cam-capable spot is marked directly on the map.</p>
              </article>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}

export default App
