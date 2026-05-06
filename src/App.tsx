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

const allSpots = spotsCatalog as Spot[]

type FocusPoint = {
  latitude: number
  longitude: number
}

const emptyTideSummary: TideSummary = {
  currentSeaLevelHeight: null,
  currentTrend: 'slack',
  nextHigh: null,
  nextLow: null,
  upcoming: [],
}

const crowdPopularityScore = {
  High: 92,
  Medium: 68,
  Low: 42,
} as const

const distanceToPoint = (spot: Spot, point: FocusPoint) => {
  const latDelta = spot.latitude - point.latitude
  const lonDelta = spot.longitude - point.longitude
  return Math.sqrt(latDelta * latDelta + lonDelta * lonDelta)
}

const formatPopularity = (spot: Spot) => `${crowdPopularityScore[spot.crowd]}/100 popularity`

const joinTideTimes = (times: string[]) => (times.length ? times.join(' · ') : '--')

function App() {
  const [selectedSpotId, setSelectedSpotId] = useState('')
  const [visibleSpotIds, setVisibleSpotIds] = useState<string[]>([])
  const [spotQuery, setSpotQuery] = useState('')
  const [focusPoint, setFocusPoint] = useState<FocusPoint | null>(null)
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
        const firstId = payload.spots[0]?.spot.id || allSpots[0]?.id || ''
        setSelectedSpotId((current) => current || firstId)
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
          notes: ['Approximate current conditions come from the nearest global wave-field point until live detail loads.'],
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
  const effectiveFocusPoint = useMemo(
    () => focusPoint ?? (selectedSpot ? { latitude: selectedSpot.latitude, longitude: selectedSpot.longitude } : null),
    [focusPoint, selectedSpot],
  )

  useEffect(() => {
    if (!selectedSpot) {
      return
    }

    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const selectSpot = (spot: Spot) => {
    setSelectedSpotId(spot.id)
    setFocusPoint({ latitude: spot.latitude, longitude: spot.longitude })
  }

  const searchSuggestions = useMemo(() => {
    const query = spotQuery.trim().toLowerCase()
    if (!query) return [] as Spot[]
    return allSpots
      .filter((spot) => [spot.name, spot.region, spot.country].some((value) => value.toLowerCase().includes(query)))
      .sort((a, b) => crowdPopularityScore[b.crowd] - crowdPopularityScore[a.crowd] || a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [spotQuery])

  const nearbySpots = useMemo(() => {
    if (!effectiveFocusPoint) return [] as Spot[]
    return [...allSpots]
      .sort((a, b) => distanceToPoint(a, effectiveFocusPoint) - distanceToPoint(b, effectiveFocusPoint))
      .slice(0, 8)
  }, [effectiveFocusPoint])

  const spotList = useMemo(() => {
    const query = spotQuery.trim().toLowerCase()
    if (query) {
      return allSpots
        .filter((spot) => [spot.name, spot.region, spot.country].some((value) => value.toLowerCase().includes(query)))
        .slice(0, 24)
    }

    if (nearbySpots.length) return nearbySpots
    if (visibleSpotIds.length) return visibleSpotIds.map((id) => spotById.get(id)).filter((spot): spot is Spot => Boolean(spot)).slice(0, 24)
    return allSpots.slice(0, 24)
  }, [nearbySpots, spotById, spotQuery, visibleSpotIds])

  const currentForecast = detailForecast?.current ?? summary?.current ?? null
  const nextWindow = detailForecast?.nextBestWindow ?? summary?.nextBestWindow ?? null

  const currentHighTimes = detailForecast?.daily[0]?.tideEvents.filter((event) => event.type === 'high').map((event) => formatHour(event.time)) ?? []
  const currentLowTimes = detailForecast?.daily[0]?.tideEvents.filter((event) => event.type === 'low').map((event) => formatHour(event.time)) ?? []

  const generatedAtText = dataset
    ? new Date(dataset.generatedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '--'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Wave Watch</p>
          <h1>Simple surf check.</h1>
          <p className="header-copy">Map at the top, pick a spot, then get the waves, tides, wind, and the next few days without digging around.</p>
        </div>
        <span className="status-pill">Updated {generatedAtText}</span>
      </header>

      <main className="app-stack">
        {dataset ? (
          <WorldMap
            collection={dataset}
            spotCatalog={allSpots}
            summaryById={derivedSummaryById}
            selectedSpotId={activeSpotId}
            onSelectSpot={(spotId) => {
              const spot = spotById.get(spotId)
              setSelectedSpotId(spotId)
              if (spot) setFocusPoint({ latitude: spot.latitude, longitude: spot.longitude })
            }}
            onSelectPoint={(latitude, longitude) => setFocusPoint({ latitude, longitude })}
            onVisibleSpotIdsChange={setVisibleSpotIds}
          />
        ) : null}

        <section className="panel selector-panel">
          <div className="section-heading simple-heading">
            <div>
              <p className="eyebrow">Spot selector</p>
              <h2>Currently selected: {selectedSpot?.name ?? 'Loading spot'}</h2>
              <p className="muted-text">{selectedSpot ? `${selectedSpot.region}, ${selectedSpot.country}` : 'Pick a spot from the list below.'}</p>
            </div>
          </div>

          <label className="spot-search">
            <span>Search spots</span>
            <input
              type="search"
              value={spotQuery}
              onChange={(event) => setSpotQuery(event.target.value)}
              placeholder="Search by spot, region, or country"
              list="spot-search-suggestions"
              autoComplete="off"
            />
            <datalist id="spot-search-suggestions">
              {searchSuggestions.map((spot) => (
                <option key={spot.id} value={spot.name}>{`${spot.region}, ${spot.country}`}</option>
              ))}
            </datalist>
          </label>

          <div className="spot-picker-row">
            {(searchSuggestions.length ? searchSuggestions : spotList).map((spot) => (
              <button
                key={spot.id}
                type="button"
                className={`spot-pill ${spot.id === activeSpotId ? 'active' : ''}`}
                onClick={() => selectSpot(spot)}
              >
                <strong>{spot.name}</strong>
                <small>{spot.region}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel current-panel">
          <div className="section-heading simple-heading">
            <div>
              <p className="eyebrow">Current conditions</p>
              <h2>{currentForecast ? describeScore(currentForecast.score) : 'Loading conditions'}</h2>
            </div>
            <div className="score-badge">
              <strong>{currentForecast?.score ?? '—'}</strong>
              <span>score</span>
            </div>
          </div>

          <div className="metrics-grid">
            <article className="metric-card">
              <span>Wave</span>
              <strong>{currentForecast ? `${currentForecast.waveHeight.toFixed(1)}m @ ${currentForecast.wavePeriod.toFixed(1)}s` : '--'}</strong>
              <p>{currentForecast ? `${formatDirection(currentForecast.waveDirection)} swell` : 'Loading'}</p>
            </article>
            <article className="metric-card">
              <span>Tide</span>
              <strong>
                {currentForecast?.seaLevelHeight !== null && currentForecast?.seaLevelHeight !== undefined
                  ? `${currentForecast.seaLevelHeight.toFixed(2)}m ${currentForecast.tideTrend}`
                  : '--'}
              </strong>
              <p>High {joinTideTimes(currentHighTimes)} · Low {joinTideTimes(currentLowTimes)}</p>
            </article>
            <article className="metric-card">
              <span>Wind</span>
              <strong>{currentForecast ? `${currentForecast.windSpeed.toFixed(0)} km/h ${formatDirection(currentForecast.windDirection)}` : '--'}</strong>
              <p>{selectedSpot ? `Best with ${selectedSpot.tideWindow.toLowerCase()}` : 'Loading'}</p>
            </article>
            <article className="metric-card">
              <span>Weather</span>
              <strong>{currentForecast ? `${currentForecast.airTemperature.toFixed(0)}°C air · ${currentForecast.waterTemperature.toFixed(0)}°C water` : '--'}</strong>
              <p>{nextWindow ? `Best next window ${formatHour(nextWindow.time)}` : 'Loading next window'}</p>
            </article>
          </div>
        </section>

        <section className="panel future-panel">
          <div className="section-heading simple-heading">
            <div>
              <p className="eyebrow">Forecast</p>
              <h2>Coming days</h2>
              <p className="muted-text">Simple daily surf, tide, wind, and weather outlook.</p>
            </div>
          </div>

          {loading ? (
            <div className="empty-state">Loading map package…</div>
          ) : error && !dataset ? (
            <div className="empty-state">{error}</div>
          ) : detailLoading ? (
            <div className="empty-state">Loading spot forecast…</div>
          ) : detailForecast ? (
            <div className="forecast-list">
              {detailForecast.daily.map((day) => {
                const highTimes = day.tideEvents.filter((event) => event.type === 'high').map((event) => formatHour(event.time))
                const lowTimes = day.tideEvents.filter((event) => event.type === 'low').map((event) => formatHour(event.time))
                return (
                  <article className="forecast-day" key={day.date}>
                    <div className="forecast-day-head">
                      <div>
                        <p>{day.label}</p>
                        <strong>{day.maxWaveHeight.toFixed(1)}m max</strong>
                      </div>
                      <span className="mini-score">{day.bestScore}</span>
                    </div>
                    <p className="forecast-copy">{day.outlook}</p>
                    <div className="forecast-lines">
                      <span>Surf {day.minWaveHeight.toFixed(1)}–{day.maxWaveHeight.toFixed(1)}m · {day.avgWavePeriod.toFixed(1)}s</span>
                      <span>Wind {day.avgWindSpeed.toFixed(0)} km/h · Air {day.avgAirTemperature.toFixed(0)}°C</span>
                      <span>High {joinTideTimes(highTimes)}</span>
                      <span>Low {joinTideTimes(lowTimes)}</span>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="empty-state">Pick a spot to see the daily forecast.</div>
          )}
        </section>

        <section className="panel extra-panel">
          <div className="section-heading simple-heading">
            <div>
              <p className="eyebrow">Spot notes</p>
              <h2>Quick read</h2>
            </div>
          </div>

          <div className="notes-grid">
            <article className="note-card">
              <span>Skill</span>
              <strong>{selectedSpot?.skill ?? '--'}</strong>
              <p>{selectedSpot ? `${selectedSpot.boardHint} works well here.` : 'Loading spot notes'}</p>
            </article>
            <article className="note-card">
              <span>Popularity</span>
              <strong>{selectedSpot ? formatPopularity(selectedSpot) : '--'}</strong>
              <p>{selectedSpot ? `${selectedSpot.crowd} crowd usually.` : 'Loading spot notes'}</p>
            </article>
            <article className="note-card">
              <span>Nearby</span>
              <strong>{nearbySpots[1]?.name ?? '--'}</strong>
              <p>{nearbySpots.length > 1 ? 'Easy backup nearby if this one looks off.' : 'Pan the map for nearby options.'}</p>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
