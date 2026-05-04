import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const spotsPath = path.join(root, 'src', 'data', 'spots.json')
const outputDir = path.join(root, 'public', 'data')
const mapOutputPath = path.join(outputDir, 'map-data.json')
const cacheDir = path.join(root, '.cache', 'forecast-fetches')
const cacheTtlMs = 12 * 60 * 60 * 1000
const summaryBatchSize = Number(process.env.SPOT_BATCH_SIZE || 50)
const summaryForecastDays = Number(process.env.SPOT_FORECAST_DAYS || 2)
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000)
const maxSpots = Number(process.env.MAX_SPOTS || 0)

const marineBase = 'https://marine-api.open-meteo.com/v1/marine'
const weatherBase = 'https://api.open-meteo.com/v1/forecast'
const waveModels = [
  { key: 'ecmwf_wam', label: 'ECMWF WAM', weight: 0.45 },
  { key: 'ncep_gfswave025', label: 'NCEP GFS-Wave', weight: 0.35 },
  { key: 'meteofrance_wave', label: 'Météo-France Wave', weight: 0.2 },
]
const weatherModels = [
  { key: 'ecmwf_ifs025', label: 'ECMWF IFS', weight: 0.55 },
  { key: 'gfs_seamless', label: 'NOAA GFS', weight: 0.45 },
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const safeNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const hourLabel = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
})
const dayLabel = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const circularDistance = (a, b) => {
  const delta = Math.abs(a - b) % 360
  return Math.min(delta, 360 - delta)
}

const weightedAverage = (entries) => {
  const valid = entries.filter((entry) => safeNumber(entry.value) !== null)
  if (!valid.length) return null
  const weightSum = valid.reduce((sum, entry) => sum + entry.weight, 0)
  return valid.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weightSum
}

const weightedDirection = (entries) => {
  const valid = entries.filter((entry) => safeNumber(entry.value) !== null)
  if (!valid.length) return null
  const x = valid.reduce(
    (sum, entry) => sum + Math.cos((entry.value * Math.PI) / 180) * entry.weight,
    0,
  )
  const y = valid.reduce(
    (sum, entry) => sum + Math.sin((entry.value * Math.PI) / 180) * entry.weight,
    0,
  )
  const angle = (Math.atan2(y, x) * 180) / Math.PI
  return (angle + 360) % 360
}

const stdev = (values) => {
  const valid = values.filter((value) => safeNumber(value) !== null)
  if (valid.length <= 1) return 0
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length
  const variance =
    valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length
  return Math.sqrt(variance)
}

const classifyTideTrend = (current, next) => {
  if (safeNumber(current) === null || safeNumber(next) === null) return 'slack'
  const delta = next - current
  if (Math.abs(delta) < 0.02) return 'slack'
  return delta > 0 ? 'rising' : 'falling'
}

const indexByTime = (times) =>
  new Map((Array.isArray(times) ? times : []).map((time, index) => [time, index]))

const summarizeTide = (hourly) => {
  const extremes = []
  for (let index = 1; index < hourly.length - 1; index += 1) {
    const previous = hourly[index - 1]?.seaLevelHeight
    const current = hourly[index]?.seaLevelHeight
    const next = hourly[index + 1]?.seaLevelHeight
    if (
      safeNumber(previous) === null ||
      safeNumber(current) === null ||
      safeNumber(next) === null
    ) {
      continue
    }
    if (current >= previous && current > next) {
      extremes.push({ time: hourly[index].time, type: 'high', seaLevelHeight: Number(current.toFixed(2)) })
    } else if (current <= previous && current < next) {
      extremes.push({ time: hourly[index].time, type: 'low', seaLevelHeight: Number(current.toFixed(2)) })
    }
  }

  return {
    currentSeaLevelHeight: hourly[0]?.seaLevelHeight ?? null,
    currentTrend: hourly[0]?.tideTrend ?? 'slack',
    nextHigh: extremes.find((entry) => entry.type === 'high') ?? null,
    nextLow: extremes.find((entry) => entry.type === 'low') ?? null,
    upcoming: extremes.slice(0, 8),
  }
}

const windAlignment = (windDirection, offshoreDirections) => {
  const bestDistance = Math.min(
    ...offshoreDirections.map((dir) => circularDistance(dir, windDirection)),
  )
  return 1 - clamp(bestDistance / 180, 0, 1)
}

const scoreHour = (spot, point) => {
  const heightMid = (spot.idealSwellMin + spot.idealSwellMax) / 2
  const heightSpan = Math.max((spot.idealSwellMax - spot.idealSwellMin) / 2, 0.5)
  const heightFit = 1 - clamp(Math.abs(point.waveHeight - heightMid) / heightSpan, 0, 1)
  const periodFit = clamp((point.wavePeriod - 7) / Math.max(spot.idealPeriodMin - 7, 1), 0, 1)
  const windFit = 1 - clamp(point.windSpeed / 30, 0, 1)
  const offshoreFit = windAlignment(point.windDirection, spot.offshoreDirections)
  const confidenceFit = point.confidence / 100

  return Math.round(
    (heightFit * 0.34 + periodFit * 0.24 + windFit * 0.14 + offshoreFit * 0.18 + confidenceFit * 0.1) * 100,
  )
}

const summarizeDaily = (hourly) => {
  const buckets = new Map()
  for (const point of hourly) {
    const date = point.time.slice(0, 10)
    const bucket = buckets.get(date) ?? []
    bucket.push(point)
    buckets.set(date, bucket)
  }

  return Array.from(buckets.entries()).map(([date, points]) => {
    const best = [...points].sort((a, b) => b.score - a.score)[0]
    const tideHeights = points
      .map((point) => point.seaLevelHeight)
      .filter((value) => safeNumber(value) !== null)
    return {
      date,
      label: dayLabel.format(new Date(date)),
      maxWaveHeight: Math.max(...points.map((point) => point.waveHeight)),
      minWaveHeight: Math.min(...points.map((point) => point.waveHeight)),
      maxSeaLevelHeight: tideHeights.length ? Math.max(...tideHeights) : null,
      minSeaLevelHeight: tideHeights.length ? Math.min(...tideHeights) : null,
      tideRange: tideHeights.length
        ? Number((Math.max(...tideHeights) - Math.min(...tideHeights)).toFixed(2))
        : null,
      avgWavePeriod:
        points.reduce((sum, point) => sum + point.wavePeriod, 0) / points.length,
      avgWindSpeed:
        points.reduce((sum, point) => sum + point.windSpeed, 0) / points.length,
      bestScore: best.score,
      bestHour: hourLabel.format(new Date(best.time)),
      confidence:
        points.reduce((sum, point) => sum + point.confidence, 0) / points.length,
    }
  })
}

const fetchJsonWithRetry = async (url, retries = 5) => {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let timeout = null
    try {
      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
      const response = await fetch(url, {
        headers: { 'user-agent': 'wave-watch-build/1.0' },
        signal: controller.signal,
      })
      if (!response.ok) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null
        const error = new Error(`HTTP ${response.status} for ${url}`)
        error.retryAfterMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : response.status === 429
            ? Math.min(8000 * attempt, 45000)
            : null
        throw error
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (error?.name === 'AbortError') {
        lastError = new Error(`Request timeout for ${url}`)
      }
      if (attempt < retries) {
        const retryAfterMs =
          typeof error?.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
            ? error.retryAfterMs
            : 1000 * attempt
        await delay(retryAfterMs)
      }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  throw lastError
}

const cachePathForUrl = (url) =>
  path.join(cacheDir, `${createHash('sha1').update(String(url)).digest('hex')}.json`)

const fetchJsonCached = async (url, { forceRefresh = false } = {}) => {
  const cachePath = cachePathForUrl(url)

  if (!forceRefresh) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'))
      if (
        raw?.fetchedAt &&
        Date.now() - new Date(raw.fetchedAt).getTime() < cacheTtlMs &&
        raw?.payload !== undefined
      ) {
        return raw.payload
      }
    } catch {
      // Cache miss/stale/corrupt: refetch.
    }
  }

  const payload = await fetchJsonWithRetry(url)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(
    cachePath,
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), url: String(url), payload })}\n`,
  )
  return payload
}

const parseValue = (token) => {
  if (!token || token === 'MM' || token === 'N/A') return null
  const value = Number(token)
  return Number.isFinite(value) ? value : null
}

const parseBuoyTimestamp = (parts) => {
  const [year, month, day, hour, minute] = parts.slice(0, 5).map((part) => Number(part))
  return new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString()
}

const fetchBuoyObservation = async (spot) => {
  if (!spot.buoyStationId) return null
  try {
    const [obsResponse, specResponse] = await Promise.all([
      fetch(`https://www.ndbc.noaa.gov/data/realtime2/${spot.buoyStationId}.txt`, {
        headers: { 'user-agent': 'wave-watch-build/1.0' },
      }),
      fetch(`https://www.ndbc.noaa.gov/data/realtime2/${spot.buoyStationId}.spec`, {
        headers: { 'user-agent': 'wave-watch-build/1.0' },
      }),
    ])

    if (!obsResponse.ok) return null

    const obsLines = (await obsResponse.text()).trim().split(/\r?\n/)
    const obs = obsLines[2]?.trim().split(/\s+/)
    if (!obs) return null

    let spec = null
    if (specResponse.ok) {
      const specLines = (await specResponse.text()).trim().split(/\r?\n/)
      spec = specLines[2]?.trim().split(/\s+/) ?? null
    }

    return {
      stationId: spot.buoyStationId,
      stationName: spot.buoyName,
      observedAt: parseBuoyTimestamp(obs),
      waveHeight: parseValue(obs[8]),
      dominantPeriod: parseValue(obs[9]),
      averagePeriod: parseValue(obs[10]),
      meanWaveDirection: parseValue(obs[11]),
      windSpeed: parseValue(obs[6]),
      windDirection: parseValue(obs[5]),
      airTemperature: parseValue(obs[13]),
      waterTemperature: parseValue(obs[14]),
      ...(spec
        ? {
            waveHeight: parseValue(spec[5]) ?? parseValue(obs[8]),
            dominantPeriod: parseValue(spec[7]) ?? parseValue(obs[9]),
            averagePeriod: parseValue(spec[13]) ?? parseValue(obs[10]),
            meanWaveDirection: parseValue(spec[14]) ?? parseValue(obs[11]),
          }
        : {}),
    }
  } catch {
    return null
  }
}

const blendWaveAndWeather = ({ marine, weather, index, weatherIndex = index }) => {
  let waveEntries = waveModels.map((model) => ({
    ...model,
    waveHeight: safeNumber(marine.hourly[`wave_height_${model.key}`]?.[index]),
    wavePeriod: safeNumber(marine.hourly[`wave_period_${model.key}`]?.[index]),
    waveDirection: safeNumber(marine.hourly[`wave_direction_${model.key}`]?.[index]),
    swellWaveHeight: safeNumber(marine.hourly[`swell_wave_height_${model.key}`]?.[index]),
    windWaveHeight: safeNumber(marine.hourly[`wind_wave_height_${model.key}`]?.[index]),
    waterTemperature: safeNumber(marine.hourly[`sea_surface_temperature_${model.key}`]?.[index]),
  }))

  if (!waveEntries.some((entry) => entry.waveHeight !== null || entry.wavePeriod !== null)) {
    waveEntries = [
      {
        key: 'default',
        label: 'Open-Meteo marine guidance',
        weight: 1,
        waveHeight: safeNumber(marine.hourly.wave_height?.[index]),
        wavePeriod: safeNumber(marine.hourly.wave_period?.[index]),
        waveDirection: safeNumber(marine.hourly.wave_direction?.[index]),
        swellWaveHeight: safeNumber(marine.hourly.swell_wave_height?.[index]),
        windWaveHeight: safeNumber(marine.hourly.wind_wave_height?.[index]),
        waterTemperature: safeNumber(marine.hourly.sea_surface_temperature?.[index]),
      },
    ]
  }

  let weatherEntries = weatherModels.map((model) => ({
    ...model,
    windSpeed: safeNumber(weather.hourly[`wind_speed_10m_${model.key}`]?.[weatherIndex]),
    windDirection: safeNumber(weather.hourly[`wind_direction_10m_${model.key}`]?.[weatherIndex]),
    airTemperature: safeNumber(weather.hourly[`temperature_2m_${model.key}`]?.[weatherIndex]),
  }))

  if (!weatherEntries.some((entry) => entry.windSpeed !== null || entry.airTemperature !== null)) {
    weatherEntries = [
      {
        key: 'default',
        label: 'Open-Meteo weather guidance',
        weight: 1,
        windSpeed: safeNumber(weather.hourly.wind_speed_10m?.[weatherIndex]),
        windDirection: safeNumber(weather.hourly.wind_direction_10m?.[weatherIndex]),
        airTemperature: safeNumber(weather.hourly.temperature_2m?.[weatherIndex]),
      },
    ]
  }

  const waveHeight = weightedAverage(
    waveEntries.map((entry) => ({ value: entry.waveHeight, weight: entry.weight })),
  )
  const wavePeriod = weightedAverage(
    waveEntries.map((entry) => ({ value: entry.wavePeriod, weight: entry.weight })),
  )
  const waveDirection = weightedDirection(
    waveEntries.map((entry) => ({ value: entry.waveDirection, weight: entry.weight })),
  )
  const swellWaveHeight = weightedAverage(
    waveEntries.map((entry) => ({ value: entry.swellWaveHeight, weight: entry.weight })),
  )
  const windWaveHeight = weightedAverage(
    waveEntries.map((entry) => ({ value: entry.windWaveHeight, weight: entry.weight })),
  )
  const waterTemperature = weightedAverage(
    waveEntries.map((entry) => ({ value: entry.waterTemperature, weight: entry.weight })),
  )
  const windSpeed = weightedAverage(
    weatherEntries.map((entry) => ({ value: entry.windSpeed, weight: entry.weight })),
  )
  const windDirection = weightedDirection(
    weatherEntries.map((entry) => ({ value: entry.windDirection, weight: entry.weight })),
  )
  const airTemperature = weightedAverage(
    weatherEntries.map((entry) => ({ value: entry.airTemperature, weight: entry.weight })),
  )

  return {
    waveEntries,
    weatherEntries,
    waveHeight,
    wavePeriod,
    waveDirection,
    swellWaveHeight,
    windWaveHeight,
    waterTemperature,
    windSpeed,
    windDirection,
    airTemperature,
  }
}

const buildSpotForecastFromResponses = ({ spot, marine, weather, tide, buoy, generatedAt }) => {
  const marineTimes = marine?.hourly?.time
  const weatherTimes = weather?.hourly?.time
  const tideTimes = tide?.hourly?.time ?? []
  if (!Array.isArray(marineTimes) || !marineTimes.length || !Array.isArray(weatherTimes) || !weatherTimes.length) {
    throw new Error(`No marine forecast returned for ${spot.name}`)
  }
  const tideSeaLevels = tide?.hourly?.sea_level_height_msl ?? []

  const weatherIndex = indexByTime(weatherTimes)
  const tideIndexByTime = indexByTime(tideTimes)
  const times = marineTimes.filter((time) => weatherIndex.has(time))
  if (!times.length) {
    throw new Error(`No overlapping marine/weather forecast times for ${spot.name}`)
  }

  const hourly = times.map((time, index) => {
    const marineIdx = marineTimes.indexOf(time)
    const weatherIdx = weatherIndex.get(time)
    const blend = blendWaveAndWeather({ marine, weather, index: marineIdx, weatherIndex: weatherIdx })
    const {
      waveEntries,
      waveHeight,
      wavePeriod,
      waveDirection,
      swellWaveHeight,
      windWaveHeight,
      waterTemperature,
      windSpeed,
      windDirection,
      airTemperature,
    } = blend

    if (
      waveHeight === null ||
      wavePeriod === null ||
      waveDirection === null ||
      windSpeed === null ||
      windDirection === null ||
      airTemperature === null
    ) {
      throw new Error(`Incomplete blended forecast for ${spot.name} at ${time}`)
    }

    const heightSpread = stdev(waveEntries.map((entry) => entry.waveHeight))
    const periodSpread = stdev(waveEntries.map((entry) => entry.wavePeriod))
    const modelSpread = Number((heightSpread + periodSpread * 0.12).toFixed(2))
    const confidence = Math.round(clamp(100 - heightSpread * 18 - periodSpread * 4, 30, 98))
    const tideIndex = tideIndexByTime.get(time) ?? -1
    const seaLevelHeight = safeNumber(tideSeaLevels[tideIndex])
    const nextSeaLevelHeight = safeNumber(tideSeaLevels[tideIndex + 1])

    const point = {
      time,
      waveHeight: Number(waveHeight.toFixed(2)),
      wavePeriod: Number(wavePeriod.toFixed(2)),
      waveDirection: Number(waveDirection.toFixed(0)),
      windSpeed: Number(windSpeed.toFixed(1)),
      windDirection: Number(windDirection.toFixed(0)),
      airTemperature: Number(airTemperature.toFixed(1)),
      waterTemperature: Number((waterTemperature ?? airTemperature).toFixed(1)),
      seaLevelHeight: seaLevelHeight === null ? null : Number(seaLevelHeight.toFixed(2)),
      tideTrend: classifyTideTrend(seaLevelHeight, nextSeaLevelHeight),
      swellWaveHeight: swellWaveHeight === null ? null : Number(swellWaveHeight.toFixed(2)),
      windWaveHeight: windWaveHeight === null ? null : Number(windWaveHeight.toFixed(2)),
      confidence,
      modelSpread,
    }

    return {
      ...point,
      score: scoreHour(spot, point),
    }
  })

  const current = hourly[0]
  const nextBestWindow = [...hourly].sort((a, b) => b.score - a.score)[0]
  const currentBlend = blendWaveAndWeather({ marine, weather, index: 0 })

  return {
    spot,
    source: 'generated',
    updatedAt: generatedAt,
    generatedAt,
    current,
    nextBestWindow,
    hourly,
    daily: summarizeDaily(hourly),
    tide: summarizeTide(hourly),
    buoy,
    modelBlend: {
      waveModels: currentBlend.waveEntries.map((model) => model.label),
      weatherModels: currentBlend.weatherEntries.map((model) => model.label),
      notes: [
        'Wave fields use Open-Meteo marine guidance, with per-model blending when model-specific fields are available.',
        'Surface wind and temperature use Open-Meteo weather guidance, with per-model blending when available.',
        'Tide proxy uses Open-Meteo sea level height above mean sea level; coastal accuracy is limited.',
        'Confidence falls as model disagreement increases; hourly score favors clean offshore wind plus target swell band.',
      ],
    },
  }
}

const summarizeSpotForecast = (forecast) => ({
  spot: forecast.spot,
  source: forecast.source,
  updatedAt: forecast.updatedAt,
  generatedAt: forecast.generatedAt,
  current: forecast.current,
  nextBestWindow: forecast.nextBestWindow,
  tide: forecast.tide,
  modelBlend: forecast.modelBlend,
})

const buildSpotSummaries = async (spots, generatedAt) => {
  const spotSummaries = []
  const forceRefresh = process.env.FORCE_REFRESH === '1'
  const batches = chunk(spots, summaryBatchSize)

  for (const [batchIndex, batch] of batches.entries()) {
    console.log(`Spot summary batch ${batchIndex + 1}/${batches.length} (${batch.length} spots)`)
    const marineUrl = new URL(marineBase)
    marineUrl.search = new URLSearchParams({
      latitude: batch.map((spot) => String(spot.latitude)).join(','),
      longitude: batch.map((spot) => String(spot.longitude)).join(','),
      hourly:
        'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,wind_wave_height,sea_surface_temperature',
      forecast_days: String(summaryForecastDays),
      timezone: 'UTC',
    }).toString()

    const weatherUrl = new URL(weatherBase)
    weatherUrl.search = new URLSearchParams({
      latitude: batch.map((spot) => String(spot.latitude)).join(','),
      longitude: batch.map((spot) => String(spot.longitude)).join(','),
      hourly: 'wind_speed_10m,wind_direction_10m,temperature_2m',
      forecast_days: String(summaryForecastDays),
      timezone: 'UTC',
    }).toString()

    const tideUrl = new URL(marineBase)
    tideUrl.search = new URLSearchParams({
      latitude: batch.map((spot) => String(spot.latitude)).join(','),
      longitude: batch.map((spot) => String(spot.longitude)).join(','),
      hourly: 'sea_level_height_msl',
      forecast_days: String(summaryForecastDays),
      timezone: 'UTC',
    }).toString()

    const marineResponse = await fetchJsonCached(marineUrl, { forceRefresh })
    await delay(120)
    const weatherResponse = await fetchJsonCached(weatherUrl, { forceRefresh })
    await delay(120)
    const tideResponse = await fetchJsonCached(tideUrl, { forceRefresh })

    const marineList = Array.isArray(marineResponse) ? marineResponse : [marineResponse]
    const weatherList = Array.isArray(weatherResponse) ? weatherResponse : [weatherResponse]
    const tideList = Array.isArray(tideResponse) ? tideResponse : [tideResponse]

    for (const [index, spot] of batch.entries()) {
      const marine = marineList[index]
      const weather = weatherList[index]
      const tide = tideList[index]
      try {
        const forecast = buildSpotForecastFromResponses({
          spot,
          marine,
          weather,
          tide,
          buoy: null,
          generatedAt,
        })
        spotSummaries.push(summarizeSpotForecast(forecast))
      } catch (error) {
        console.warn(`Skipping ${spot.name}: ${error instanceof Error ? error.message : 'invalid forecast data'}`)
      }
    }

    await delay(350)
  }

  console.log(`Built ${spotSummaries.length} spot summaries from ${spots.length} catalog spots`)

  return spotSummaries
}

const buildMapFieldPoints = () => {
  const points = []
  for (let latitude = 60; latitude >= -60; latitude -= 10) {
    for (let longitude = -180; longitude < 180; longitude += 10) {
      points.push({ latitude, longitude })
    }
  }
  return points
}

const chunk = (items, size) => {
  const out = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

const buildMapField = async (generatedAt) => {
  const grid = buildMapFieldPoints()
  const elevationBatches = chunk(grid, 80)
  const oceanGrid = []
  const forceRefresh = process.env.FORCE_REFRESH === '1'

  for (const elevationBatch of elevationBatches) {
    const elevationUrl = new URL('https://api.open-meteo.com/v1/elevation')
    elevationUrl.search = new URLSearchParams({
      latitude: elevationBatch.map((point) => point.latitude).join(','),
      longitude: elevationBatch.map((point) => point.longitude).join(','),
    }).toString()

    const elevationResponse = await fetchJsonCached(elevationUrl, { forceRefresh })
    const elevations = Array.isArray(elevationResponse?.elevation)
      ? elevationResponse.elevation
      : []

    elevationBatch.forEach((point, index) => {
      const elevation = elevations[index]
      if (typeof elevation === 'number' && elevation <= 0) {
        oceanGrid.push(point)
      }
    })
  }

  const batches = chunk(oceanGrid, 12)
  const points = []

  for (const [batchIndex, batch] of batches.entries()) {
    if (batchIndex % 10 === 0) {
      console.log(`Map field batch ${batchIndex + 1}/${batches.length}`)
    }
    const marineUrl = new URL(marineBase)
    marineUrl.search = new URLSearchParams({
      latitude: batch.map((point) => point.latitude).join(','),
      longitude: batch.map((point) => point.longitude).join(','),
      hourly: 'wave_height,wave_period,wave_direction',
      forecast_days: '1',
      timezone: 'UTC',
    }).toString()

    const weatherUrl = new URL(weatherBase)
    weatherUrl.search = new URLSearchParams({
      latitude: batch.map((point) => point.latitude).join(','),
      longitude: batch.map((point) => point.longitude).join(','),
      hourly: 'wind_speed_10m,wind_direction_10m',
      forecast_days: '1',
      timezone: 'UTC',
    }).toString()

    const tideUrl = new URL(marineBase)
    tideUrl.search = new URLSearchParams({
      latitude: batch.map((point) => point.latitude).join(','),
      longitude: batch.map((point) => point.longitude).join(','),
      hourly: 'sea_level_height_msl',
      forecast_days: '1',
      timezone: 'UTC',
    }).toString()

    const marineBatch = await fetchJsonCached(marineUrl, { forceRefresh })
    await delay(100)
    const weatherBatch = await fetchJsonCached(weatherUrl, { forceRefresh })
    await delay(100)
    let tideBatch = []
    try {
      tideBatch = await fetchJsonCached(tideUrl, { forceRefresh })
    } catch (error) {
      console.warn(`Map field tide fetch failed for batch ${batchIndex + 1}/${batches.length}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    const marineList = Array.isArray(marineBatch) ? marineBatch : [marineBatch]
    const weatherList = Array.isArray(weatherBatch) ? weatherBatch : [weatherBatch]
    const tideList = Array.isArray(tideBatch) ? tideBatch : [tideBatch]

    marineList.forEach((marine, index) => {
      const pointDef = batch[index]
      if (!pointDef) return
      const weather = weatherList[index]
      const tide = tideList[index]
      if (!marine?.hourly?.time?.length || !weather?.hourly?.time?.length) return
      const blend = blendWaveAndWeather({ marine, weather, index: 0 })
      const seaLevelHeight = safeNumber(tide?.hourly?.sea_level_height_msl?.[0])
      const nextSeaLevelHeight = safeNumber(tide?.hourly?.sea_level_height_msl?.[1])
      if (
        blend.waveHeight === null ||
        blend.wavePeriod === null ||
        blend.waveDirection === null ||
        blend.windSpeed === null ||
        blend.windDirection === null
      ) {
        return
      }
      points.push({
        latitude: pointDef.latitude,
        longitude: pointDef.longitude,
        waveHeight: Number(blend.waveHeight.toFixed(2)),
        wavePeriod: Number(blend.wavePeriod.toFixed(2)),
        waveDirection: Number(blend.waveDirection.toFixed(0)),
        windSpeed: Number(blend.windSpeed.toFixed(1)),
        windDirection: Number(blend.windDirection.toFixed(0)),
        seaLevelHeight: seaLevelHeight === null ? null : Number(seaLevelHeight.toFixed(2)),
        tideTrend: classifyTideTrend(seaLevelHeight, nextSeaLevelHeight),
      })
    })

    await delay(150)
  }

  points.sort((a, b) => (b.latitude - a.latitude) || (a.longitude - b.longitude))

  const coarseLons = [...new Set(grid.map((point) => point.longitude))].sort((a, b) => a - b)
  const coarseLats = [...new Set(grid.map((point) => point.latitude))].sort((a, b) => b - a)
  const pointMap = new Map(points.map((point) => [`${point.latitude},${point.longitude}`, point]))
  const coarseU = []
  const coarseV = []

  for (const latitude of coarseLats) {
    for (const longitude of coarseLons) {
      const point = pointMap.get(`${latitude},${longitude}`)
      if (!point) {
        coarseU.push(0)
        coarseV.push(0)
        continue
      }
      const radians = ((point.waveDirection + 180) * Math.PI) / 180
      const magnitude = Math.max(point.waveHeight * 1.8 + point.wavePeriod * 0.08, 0.05)
      coarseU.push(Number((Math.sin(radians) * magnitude).toFixed(3)))
      coarseV.push(Number((-Math.cos(radians) * magnitude).toFixed(3)))
    }
  }

  const fineStep = 2
  const fineLons = []
  const fineLats = []
  for (let longitude = coarseLons[0]; longitude <= coarseLons[coarseLons.length - 1]; longitude += fineStep) {
    fineLons.push(longitude)
  }
  for (let latitude = coarseLats[0]; latitude >= coarseLats[coarseLats.length - 1]; latitude -= fineStep) {
    fineLats.push(latitude)
  }

  const coarseNx = coarseLons.length
  const coarseNy = coarseLats.length
  const dx = coarseLons.length > 1 ? coarseLons[1] - coarseLons[0] : 10
  const dy = coarseLats.length > 1 ? coarseLats[0] - coarseLats[1] : 10
  const readCoarse = (array, latIndex, lonIndex) => array[latIndex * coarseNx + lonIndex] ?? 0
  const sampleBilinear = (array, latitude, longitude) => {
    const lonPosition = (longitude - coarseLons[0]) / dx
    const latPosition = (coarseLats[0] - latitude) / dy
    const lonIndex = Math.max(0, Math.min(coarseNx - 2, Math.floor(lonPosition)))
    const latIndex = Math.max(0, Math.min(coarseNy - 2, Math.floor(latPosition)))
    const lonMix = Math.max(0, Math.min(1, lonPosition - lonIndex))
    const latMix = Math.max(0, Math.min(1, latPosition - latIndex))

    const topLeft = readCoarse(array, latIndex, lonIndex)
    const topRight = readCoarse(array, latIndex, lonIndex + 1)
    const bottomLeft = readCoarse(array, latIndex + 1, lonIndex)
    const bottomRight = readCoarse(array, latIndex + 1, lonIndex + 1)

    if ([topLeft, topRight, bottomLeft, bottomRight].every((value) => Math.abs(value) < 0.001)) {
      return 0
    }

    const top = topLeft * (1 - lonMix) + topRight * lonMix
    const bottom = bottomLeft * (1 - lonMix) + bottomRight * lonMix
    return top * (1 - latMix) + bottom * latMix
  }

  const uData = []
  const vData = []
  for (const latitude of fineLats) {
    for (const longitude of fineLons) {
      uData.push(Number(sampleBilinear(coarseU, latitude, longitude).toFixed(3)))
      vData.push(Number(sampleBilinear(coarseV, latitude, longitude).toFixed(3)))
    }
  }

  return {
    generatedAt,
    points,
    velocityData: [
      {
        header: {
          parameterCategory: 2,
          parameterNumber: 2,
          nx: fineLons.length,
          ny: fineLats.length,
          lo1: fineLons[0],
          la1: fineLats[0],
          lo2: fineLons[fineLons.length - 1],
          la2: fineLats[fineLats.length - 1],
          dx: fineStep,
          dy: fineStep,
          refTime: generatedAt,
        },
        data: uData,
      },
      {
        header: {
          parameterCategory: 2,
          parameterNumber: 3,
          nx: fineLons.length,
          ny: fineLats.length,
          lo1: fineLons[0],
          la1: fineLats[0],
          lo2: fineLons[fineLons.length - 1],
          la2: fineLats[fineLats.length - 1],
          dx: fineStep,
          dy: fineStep,
          refTime: generatedAt,
        },
        data: vData,
      },
    ],
  }
}

const main = async () => {
  const allSpots = JSON.parse(await readFile(spotsPath, 'utf8'))
  const spots = maxSpots > 0 ? allSpots.slice(0, maxSpots) : allSpots
  const generatedAt = new Date().toISOString()
  const spotForecasts = await buildSpotSummaries(spots, generatedAt)
  const mapField = await buildMapField(generatedAt)

  const payload = {
    generatedAt,
    source: 'generated',
    spots: spotForecasts,
    mapField,
    research: {
      modelingNotes: [
        'Current production blend is deterministic and weighted by model trust plus consensus spread.',
        'Next improvement step: learn spot-specific post-processing corrections against buoy observations and analysis archives.',
        'Longer term: train spot-aware skill models that adjust raw guidance by swell direction regime, season, tide proxy, and nearshore wind error.',
      ],
      analysisDataSources: [
        'NDBC realtime and historical buoy observations for verification and calibration.',
        'NOAA WAVEWATCH III / GEFS-Wave archives for forecast-vs-analysis backtests.',
        'ERA5 wave reanalysis for long-horizon climatology and bias estimation.',
        'CDIP nearshore wave archives where available for coastal truth closer to surf breaks.',
      ],
    },
  }

  await mkdir(outputDir, { recursive: true })
  await writeFile(mapOutputPath, `${JSON.stringify(payload)}\n`)
  console.log(`Wrote ${mapOutputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
