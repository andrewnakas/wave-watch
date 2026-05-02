import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const spotsPath = path.join(root, 'src', 'data', 'spots.json')
const outputDir = path.join(root, 'public', 'data')
const outputPath = path.join(outputDir, 'forecast-data.json')

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
    return {
      date,
      label: dayLabel.format(new Date(date)),
      maxWaveHeight: Math.max(...points.map((point) => point.waveHeight)),
      minWaveHeight: Math.min(...points.map((point) => point.waveHeight)),
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

const fetchJsonWithRetry = async (url, retries = 3) => {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'wave-watch-build/1.0' },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`)
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
  }
  throw lastError
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

const blendWaveAndWeather = ({ marine, weather, index }) => {
  const waveEntries = waveModels.map((model) => ({
    ...model,
    waveHeight: safeNumber(marine.hourly[`wave_height_${model.key}`]?.[index]),
    wavePeriod: safeNumber(marine.hourly[`wave_period_${model.key}`]?.[index]),
    waveDirection: safeNumber(marine.hourly[`wave_direction_${model.key}`]?.[index]),
    swellWaveHeight: safeNumber(marine.hourly[`swell_wave_height_${model.key}`]?.[index]),
    windWaveHeight: safeNumber(marine.hourly[`wind_wave_height_${model.key}`]?.[index]),
    waterTemperature: safeNumber(marine.hourly[`sea_surface_temperature_${model.key}`]?.[index]),
  }))

  const weatherEntries = weatherModels.map((model) => ({
    ...model,
    windSpeed: safeNumber(weather.hourly[`wind_speed_10m_${model.key}`]?.[index]),
    windDirection: safeNumber(weather.hourly[`wind_direction_10m_${model.key}`]?.[index]),
    airTemperature: safeNumber(weather.hourly[`temperature_2m_${model.key}`]?.[index]),
  }))

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

const buildSpotForecast = async (spot, generatedAt) => {
  const marineUrl = new URL(marineBase)
  marineUrl.search = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    hourly:
      'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,wind_wave_height,sea_surface_temperature',
    forecast_days: '14',
    timezone: 'UTC',
    models: waveModels.map((model) => model.key).join(','),
  }).toString()

  const weatherUrl = new URL(weatherBase)
  weatherUrl.search = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    hourly: 'wind_speed_10m,wind_direction_10m,temperature_2m',
    forecast_days: '14',
    timezone: 'UTC',
    models: weatherModels.map((model) => model.key).join(','),
  }).toString()

  const [marine, weather, buoy] = await Promise.all([
    fetchJsonWithRetry(marineUrl),
    fetchJsonWithRetry(weatherUrl),
    fetchBuoyObservation(spot),
  ])

  const times = marine?.hourly?.time
  if (!Array.isArray(times) || !times.length) {
    throw new Error(`No marine forecast returned for ${spot.name}`)
  }

  const hourly = times.map((time, index) => {
    const blend = blendWaveAndWeather({ marine, weather, index })
    const {
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

    const point = {
      time,
      waveHeight: Number(waveHeight.toFixed(2)),
      wavePeriod: Number(wavePeriod.toFixed(2)),
      waveDirection: Number(waveDirection.toFixed(0)),
      windSpeed: Number(windSpeed.toFixed(1)),
      windDirection: Number(windDirection.toFixed(0)),
      airTemperature: Number(airTemperature.toFixed(1)),
      waterTemperature: Number((waterTemperature ?? airTemperature).toFixed(1)),
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

  return {
    spot,
    source: 'generated',
    updatedAt: generatedAt,
    generatedAt,
    current,
    nextBestWindow,
    hourly,
    daily: summarizeDaily(hourly),
    buoy,
    modelBlend: {
      waveModels: waveModels.map((model) => model.label),
      weatherModels: weatherModels.map((model) => model.label),
      notes: [
        'Wave fields are blended from ECMWF WAM, NCEP GFS-Wave, and Météo-France wave guidance.',
        'Surface wind and temperature are blended from ECMWF IFS and NOAA GFS.',
        'Confidence falls as model disagreement increases; hourly score favors clean offshore wind plus target swell band.',
      ],
    },
  }
}

const buildMapFieldPoints = () => {
  const points = []
  for (let latitude = -55; latitude <= 55; latitude += 10) {
    for (let longitude = -180; longitude < 180; longitude += 10) {
      if (Math.abs(latitude) < 8 && Math.abs(longitude) < 20) continue
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
  const batches = chunk(grid, 40)
  const points = []

  for (const batch of batches) {
    const marineUrl = new URL(marineBase)
    marineUrl.search = new URLSearchParams({
      latitude: batch.map((point) => point.latitude).join(','),
      longitude: batch.map((point) => point.longitude).join(','),
      hourly: 'wave_height,wave_period,wave_direction',
      forecast_days: '1',
      timezone: 'UTC',
      models: waveModels.map((model) => model.key).join(','),
    }).toString()

    const weatherUrl = new URL(weatherBase)
    weatherUrl.search = new URLSearchParams({
      latitude: batch.map((point) => point.latitude).join(','),
      longitude: batch.map((point) => point.longitude).join(','),
      hourly: 'wind_speed_10m,wind_direction_10m',
      forecast_days: '1',
      timezone: 'UTC',
      models: weatherModels.map((model) => model.key).join(','),
    }).toString()

    const [marineBatch, weatherBatch] = await Promise.all([
      fetchJsonWithRetry(marineUrl),
      fetchJsonWithRetry(weatherUrl),
    ])

    const marineList = Array.isArray(marineBatch) ? marineBatch : [marineBatch]
    const weatherList = Array.isArray(weatherBatch) ? weatherBatch : [weatherBatch]

    marineList.forEach((marine, index) => {
      const weather = weatherList[index]
      if (!marine?.hourly?.time?.length || !weather?.hourly?.time?.length) return
      const blend = blendWaveAndWeather({ marine, weather, index: 0 })
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
        latitude: batch[index].latitude,
        longitude: batch[index].longitude,
        waveHeight: Number(blend.waveHeight.toFixed(2)),
        wavePeriod: Number(blend.wavePeriod.toFixed(2)),
        waveDirection: Number(blend.waveDirection.toFixed(0)),
        windSpeed: Number(blend.windSpeed.toFixed(1)),
        windDirection: Number(blend.windDirection.toFixed(0)),
      })
    })
  }

  return {
    generatedAt,
    points,
  }
}

const main = async () => {
  const spots = JSON.parse(await readFile(spotsPath, 'utf8'))
  const generatedAt = new Date().toISOString()
  const spotForecasts = []

  for (const spot of spots) {
    const forecast = await buildSpotForecast(spot, generatedAt)
    spotForecasts.push(forecast)
  }

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
  await writeFile(outputPath, `${JSON.stringify(payload)}\n`)
  console.log(`Wrote ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
