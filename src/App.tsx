import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { WorldMap } from './components/WorldMap'
import spotsCatalog from './data/spots.json'
import {
  describeScore,
  formatDirection,
  formatHour,
  loadLiveSpotForecast,
  loadMapDataset,
  scoreHour,
} from './lib/forecast'
import type { ForecastPayload, MapDataset, Spot, SpotSummary, TideSummary } from './types'

const FAVORITES_KEY = 'wave-w…ites'
const allSpots = spotsCatalog as Spot[]

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

const emptyTideSummary: TideSummary = {
  currentSeaLevelHeight: null,
  currentTrend: 'slack',
  nextHigh: null,
  nextLow: null,
  upcoming: [],
}

function App() {
  const [selectedSpotId, setSelectedSpotId] = useState('')
  const [visibleSpotIds, setVisibleSpotIds] = useState<string[]>([])
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites())
  const [spotQuery, setSpotQuery] = useState('')
  const [dataset, setDataset] = useState<MapDataset | null>(null)
  const [detailForecast, setDetailForecast] = useState<ForecastPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    loadMapDataset()
      .then((payload) => {
        if (!active) return
        setDataset(payload)
        setSelectedSpotId((current) => current || payload.spots[0]?.spot.id || allSpots[0]?.id || '')
      })
      .catch((caught) => {
        if (!active) return
        setError(caught instanceof Error ? caught.message : 'Could not load map data package.')
        setSelectedSpotId((current) => current || allSpots[0]?.id || '')
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const spotById = useMemo(() => new Map(allSpots.map((spot) => [spot.id, spot])), [])

  const derivedSummaryById = useMemo(() => {
    const summaries = new Map<string, SpotSummary>()
    const points = dataset?.mapField.points ?? []
    const prebuilt = new Map(dataset?.spots.map((summary) => [summary.spot.id, summary]) ?? [])

    const nearestPointFor = (spot: Spot) => {
      if (!points.length) return null
      return points.reduce((best, point) => {
        const bestDistance = (best.latitude - spot.latitude) ** 2 + (best.longitude - spot.longitude) ** 2
        const pointDistance = (point.latitude - spot.latitude) ** 2 + (point.longitude - spot.longitude) ** 2
        return pointDistance < bestDistance ? point : best
      })
    }

    for (const spot of allSpots) {
      const exact = prebuilt.get(spot.id)
      if (exact) {
        summaries.set(spot.id, exact)
        continue
      }
      const point = nearestPointFor(spot)
      if (!point) continue
      const current = {
        time: dataset?.generatedAt ?? new Date().toISOString(),
        waveHeight: point.waveHeight,
        wavePeriod: point.wavePeriod,
        waveDirection: point.waveDirection,
        windSpeed: point.windSpeed,
        windDirection: point.windDirection,
        airTemperature: 0,
        waterTemperature: 0,
        seaLevelHeight: point.seaLevelHeight,
        tideTrend: point.tideTrend,
        confidence: 55,
        modelSpread: 0,
        score: scoreHour(spot, point),
      }
      summaries.set(spot.id, {
        spot,
        source: 'generated',
        updatedAt: dataset?.generatedAt ?? new Date().toISOString(),
        generatedAt: dataset?.generatedAt ?? new Date().toISOString(),
        current,
        nextBestWindow: current,
        tide: {
          ...emptyTideSummary,
          currentSeaLevelHeight: current.seaLevelHeight,
          currentTrend: current.tideTrend,
        },
        modelBlend: {
          waveModels: ['Global map field estimate'],
          weatherModels: ['Global map field estimate'],
          notes: ['Approximate current conditions are derived from the nearest global wave-field point until full live detail loads.'],
        },
      })
    }

    return summaries
  }, [dataset])

  const activeSpotId = useMemo(() => {
    if (!allSpots.length) return selectedSpotId
    return selectedSpotId && spotById.has(selectedSpotId) ? selectedSpotId : allSpots[0].id
  }, [selectedSpotId, spotById])

  const selectedSpot = spotById.get(activeSpotId) ?? null
  const summary = derivedSummaryById.get(activeSpotId) ?? null

  useEffect(() => {
    if (!selectedSpot) {
      setDetailForecast(null)
      return
    }

    let active = true
    setDetailLoading(true)
    setDetailForecast(null)

    loadLiveSpotForecast(selectedSpot)
      .then((forecast) => {
        if (active) setDetailForecast(forecast)
      })
      .catch(() => {
        if (active) setDetailForecast(null)
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })

    return () => {
      active = false
    }
  }, [selectedSpot])

  const toggleFavorite = (spotId: string) => {
    setFavorites((current) => {
      const next = current.includes(spotId) ? current.filter((id) => id !== spotId) : [...current, spotId]
      saveFavorites(next)
      return next
    })
  }

  const favoriteSpots = useMemo(() => allSpots.filter((spot) => favorites.includes(spot.id)), [favorites])

  const spotList = useMemo(() => {
    const query = spotQuery.trim().toLowerCase()
    const source = query
      ? allSpots.filter((spot) =>
          [spot.name, spot.region, spot.country].some((value) => value.toLowerCase().includes(query)),
        )
      : visibleSpotIds.length
        ? visibleSpotIds.map((id) => spotById.get(id)).filter((spot): spot is Spot => Boolean(spot))
        : allSpots

    return [...source]
      .sort((a, b) => {
        const aScore = derivedSummaryById.get(a.id)?.current.score ?? -1
        const bScore = derivedSummaryById.get(b.id)?.current.score ?? -1
        if (bScore !== aScore) return bScore - aScore
        return a.name.localeCompare(b.name)
      })
      .slice(0, query ? 300 : 220)
  }, [derivedSummaryById, spotById, spotQuery, visibleSpotIds])

  const chartPoints = useMemo(() => {
    const hours = detailForecast?.hourly.slice(0, 24) ?? []
    if (!hours.length) return ''
    return hours
      .map((point, index) => {
        const x = (index / Math.max(hours.length - 1, 1)) * 100
        const y = 100 - Math.min(point.waveHeight / 6, 1) * 100
        return `${x},${y}`
      })
      .join(' ')
  }, [detailForecast])

  const generatedAtText = dataset
    ? new Date(dataset.generatedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '--'

  const tideCoverage = Array.from(derivedSummaryById.values()).filter((spot) => spot.current.seaLevelHeight !== null).length

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Wave Watch</p>
          <h1>Map-first surf discovery with global waves and live spot detail.</h1>
        </div>
        <div className="topbar-meta">
          <span className="status-pill">
            {allSpots.length.toLocaleString()} spots · {tideCoverage.toLocaleString()} tide snapshots · {generatedAtText}
          </span>
          <a className="ghost-button" href={`${import.meta.env.BASE_URL}data/map-data.json`} target="_blank" rel="noreferrer">
            View raw map data
          </a>
        </div>
      </header>

      <main className="app-main">
        {dataset ? (
          <WorldMap
            collection={dataset}
            spotCatalog={allSpots}
            summaryById={derivedSummaryById}
            selectedSpotId={activeSpotId}
            onSelectSpot={setSelectedSpotId}
            onVisibleSpotIdsChange={setVisibleSpotIds}
          />
        ) : null}

        <div className="layout-grid map-first-grid">
          <section className="hero-column">
            <section className="panel hero-panel">
              <div className="hero-copy">
                <p className="eyebrow">Now watching</p>
                <div className="hero-title-row">
                  <div>
                    <h2>{selectedSpot?.name ?? 'Loading'}</h2>
                    <p>{selectedSpot ? `${selectedSpot.region}, ${selectedSpot.country}` : 'Waiting on map selection'}</p>
                  </div>
                  <div className="score-badge">
                    <strong>{(detailForecast?.current.score ?? summary?.current.score) ?? '—'}</strong>
                    <span>{detailForecast || summary ? describeScore(detailForecast?.current.score ?? summary?.current.score ?? 0) : 'Loading'}</span>
                  </div>
                </div>
                <p className="hero-summary">
                  {selectedSpot
                    ? `Best tide: ${selectedSpot.tideWindow}. Live tide: ${(detailForecast?.current.seaLevelHeight ?? summary?.current.seaLevelHeight)?.toFixed(2) ?? '--'}m and ${detailForecast?.current.tideTrend ?? summary?.current.tideTrend ?? 'slack'}. Best board: ${selectedSpot.boardHint}. Ideal swell ${selectedSpot.idealSwellMin}–${selectedSpot.idealSwellMax}m @ ${selectedSpot.idealPeriodMin}+s.`
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
                  <strong>{detailForecast ? `${detailForecast.current.waveHeight.toFixed(1)}m` : summary ? `${summary.current.waveHeight.toFixed(1)}m` : '--'}</strong>
                  <p>{detailForecast ? 'Live spot forecast loaded.' : 'Approximate current from global wave field.'}</p>
                </article>
                <article className="stat-card">
                  <span>Wave period</span>
                  <strong>{detailForecast ? `${detailForecast.current.wavePeriod.toFixed(1)}s` : summary ? `${summary.current.wavePeriod.toFixed(1)}s` : '--'}</strong>
                  <p>{selectedSpot ? `Skill ${selectedSpot.skill} · crowd ${selectedSpot.crowd}` : 'Loading'}</p>
                </article>
                <article className="stat-card">
                  <span>Wind</span>
                  <strong>
                    {detailForecast
                      ? `${detailForecast.current.windSpeed.toFixed(0)} km/h ${formatDirection(detailForecast.current.windDirection)}`
                      : summary
                        ? `${summary.current.windSpeed.toFixed(0)} km/h ${formatDirection(summary.current.windDirection)}`
                        : '--'}
                  </strong>
                  <p>{selectedSpot ? `Offshore ${selectedSpot.offshoreDirections.join('° / ')}°` : 'Loading'}</p>
                </article>
                <article className="stat-card">
                  <span>Tide now</span>
                  <strong>
                    {(detailForecast?.current.seaLevelHeight ?? summary?.current.seaLevelHeight) !== null && (detailForecast?.current.seaLevelHeight ?? summary?.current.seaLevelHeight) !== undefined
                      ? `${(detailForecast?.current.seaLevelHeight ?? summary?.current.seaLevelHeight ?? 0).toFixed(2)}m ${detailForecast?.current.tideTrend ?? summary?.current.tideTrend ?? 'slack'}`
                      : '--'}
                  </strong>
                  <p>
                    {detailForecast?.tide.nextHigh
                      ? `Next high ${formatHour(detailForecast.tide.nextHigh.time)}`
                      : detailForecast?.tide.nextLow
                        ? `Next low ${formatHour(detailForecast.tide.nextLow.time)}`
                        : detailForecast
                          ? 'Watching for the next turn'
                          : 'Detailed tide curve loads on click'}
                  </p>
                </article>
                <article className="stat-card accent-card">
                  <span>Next best window</span>
                  <strong>{detailForecast ? formatHour(detailForecast.nextBestWindow.time) : summary ? 'Now' : '--'}</strong>
                  <p>
                    {detailForecast
                      ? `${detailForecast.nextBestWindow.waveHeight.toFixed(1)}m · ${detailForecast.nextBestWindow.wavePeriod.toFixed(1)}s · ${detailForecast.nextBestWindow.confidence}% confidence`
                      : summary
                        ? `${summary.current.waveHeight.toFixed(1)}m · ${summary.current.wavePeriod.toFixed(1)}s · map estimate`
                        : 'Scanning...'}
                  </p>
                </article>
              </div>
            </section>

            <section className="panel chart-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Live spot detail</p>
                  <h2>24-hour wave pulse</h2>
                </div>
                <span className="muted-text">
                  {detailForecast ? `${detailForecast.current.confidence}% confidence now` : detailLoading ? 'Loading live forecast…' : 'Click a spot for live detail'}
                </span>
              </div>

              {loading ? (
                <div className="empty-state">Loading map package…</div>
              ) : error && !dataset ? (
                <div className="empty-state">{error}</div>
              ) : detailLoading ? (
                <div className="empty-state">Loading live tide and forecast for this spot…</div>
              ) : detailForecast ? (
                <>
                  <div className="line-chart-wrap">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="line-chart">
                      <polyline fill="none" stroke="rgba(116, 214, 255, 0.95)" strokeWidth="2" points={chartPoints} />
                    </svg>
                  </div>
                  <div className="hour-row">
                    {detailForecast.hourly.slice(0, 8).map((point) => (
                      <article className="hour-card" key={point.time}>
                        <p>{formatHour(point.time)}</p>
                        <strong>{point.waveHeight.toFixed(1)}m</strong>
                        <span>{point.wavePeriod.toFixed(1)}s period</span>
                        <small>
                          {point.confidence}% conf · tide {point.seaLevelHeight?.toFixed(2) ?? '--'}m {point.tideTrend}
                        </small>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state">The map is global and instant now. Click any spot to fetch full live tide and forecast detail.</div>
              )}
            </section>

            <section className="panel daily-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">8-day live forecast</p>
                  <h2>Pick your mission</h2>
                </div>
              </div>
              {detailForecast ? (
                <div className="daily-grid daily-grid-14">
                  {detailForecast.daily.map((day) => (
                    <article className="daily-card" key={day.date}>
                      <div>
                        <p>{day.label}</p>
                        <strong>{day.maxWaveHeight.toFixed(1)}m</strong>
                      </div>
                      <ul>
                        <li>{day.minWaveHeight.toFixed(1)}–{day.maxWaveHeight.toFixed(1)}m range</li>
                        <li>{day.avgWavePeriod.toFixed(1)}s avg period</li>
                        <li>{day.avgWindSpeed.toFixed(0)} km/h wind</li>
                        <li>{day.tideRange !== null ? `${day.tideRange.toFixed(2)}m tide range` : 'Tide range unavailable'}</li>
                        <li>Best {day.bestScore} at {day.bestHour}</li>
                        <li>{day.confidence.toFixed(0)}% confidence</li>
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">Pick a spot and I’ll fetch live 8-day detail on demand instead of shipping a giant static file for the whole planet.</div>
              )}
            </section>
          </section>

          <aside className="panel sidebar-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Spots</p>
                <h2>Find them on the map</h2>
              </div>
              <span className="muted-text">
                {allSpots.length.toLocaleString()} catalog · {spotList.length} shown · {favoriteSpots.length} saved
              </span>
            </div>

            <label className="spot-search">
              <span>Search 9,000 spots</span>
              <input
                type="search"
                value={spotQuery}
                onChange={(event) => setSpotQuery(event.target.value)}
                placeholder="Search by spot, region, or country"
              />
            </label>

            <div className="spot-list">
              {spotList.map((spot) => {
                const isFavorite = favorites.includes(spot.id)
                const isActive = spot.id === activeSpotId
                const spotSummary = derivedSummaryById.get(spot.id)
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
                      {spotSummary ? (
                        <>
                          <span>score {spotSummary.current.score}</span>
                          <span>{spotSummary.current.waveHeight.toFixed(1)}m</span>
                          <span>tide {spotSummary.current.seaLevelHeight?.toFixed(2) ?? '--'}m</span>
                        </>
                      ) : (
                        <>
                          <span>map only</span>
                          <span>{spot.skill}</span>
                          <span>{spot.crowd} crowd</span>
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </aside>

          <aside className="panel insight-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Model stack</p>
                <h2>Forecast notes</h2>
              </div>
            </div>

            <div className="insight-stack">
              <article className="insight-card emphasis">
                <span>Wave layer</span>
                <strong>Global map field</strong>
                <p>The world map and instant spot summaries come from the global wave field, not a huge per-spot static forecast blob.</p>
              </article>
              <article className="insight-card">
                <span>Detail layer</span>
                <strong>{detailForecast ? 'Live Open-Meteo spot fetch' : 'On-demand per selected spot'}</strong>
                <p>That keeps the map fast while still giving you real tide + 8-day detail when you click in.</p>
              </article>
              <article className="insight-card">
                <span>Tide coverage</span>
                <strong>{tideCoverage.toLocaleString()} spot snapshots</strong>
                <p>Instant list/map tide values are approximate snapshots; detailed tide turns load with the live spot forecast.</p>
              </article>
              <article className="insight-card">
                <span>Coverage</span>
                <strong>{allSpots.length.toLocaleString()} spots · {allSpots.filter((spot) => spot.webcamUrl).length} cams</strong>
                <p>Public webcam coverage is still partial, but every cam-capable spot is marked directly on the map.</p>
              </article>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}

export default App
