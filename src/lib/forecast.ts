import type { DaySummary, ForecastPayload, HourPoint, MapDataset, Spot, TideSummary } from '../types'

const hourLabel = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

const marineBase = 'https://marine-api.open-meteo.com/v1/marine'
const weatherBase = 'https://api.open-meteo.com/v1/forecast'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const safeNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const circularDistance = (a: number, b: number) => {
  const delta = Math.abs(a - b) % 360
  return Math.min(delta, 360 - delta)
}

const weightedAverage = (entries: Array<{ value: number | null; weight: number }>) => {
  const valid = entries.filter((entry) => entry.value !== null)
  if (!valid.length) return null
  const weightSum = valid.reduce((sum, entry) => sum + entry.weight, 0)
  return valid.reduce((sum, entry) => sum + (entry.value ?? 0) * entry.weight, 0) / weightSum
}

const weightedDirection = (entries: Array<{ value: number | null; weight: number }>) => {
  const valid = entries.filter((entry) => entry.value !== null)
  if (!valid.length) return null
  const x = valid.reduce((sum, entry) => sum + Math.cos(((entry.value ?? 0) * Math.PI) / 180) * entry.weight, 0)
  const y = valid.reduce((sum, entry) => sum + Math.sin(((entry.value ?? 0) * Math.PI) / 180) * entry.weight, 0)
  const angle = (Math.atan2(y, x) * 180) / Math.PI
  return (angle + 360) % 360
}

const stdev = (values: Array<number | null>) => {
  const valid = values.filter((value): value is number => value !== null)
  if (valid.length <= 1) return 0
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length
  const variance = valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length
  return Math.sqrt(variance)
}

const classifyTideTrend = (current: number | null, next: number | null) => {
  if (current === null || next === null) return 'slack' as const
  const delta = next - current
  if (Math.abs(delta) < 0.02) return 'slack' as const
  return delta > 0 ? ('rising' as const) : ('falling' as const)
}

const indexByTime = (times: unknown) => new Map((Array.isArray(times) ? times : []).map((time, index) => [time, index]))

const windAlignment = (windDirection: number, offshoreDirections: number[]) => {
  const bestDistance = Math.min(...offshoreDirections.map((dir) => circularDistance(dir, windDirection)))
  return 1 - clamp(bestDistance / 180, 0, 1)
}

export const scoreHour = (spot: Spot, point: Pick<HourPoint, 'waveHeight' | 'wavePeriod' | 'windSpeed' | 'windDirection'>) => {
  const heightMid = (spot.idealSwellMin + spot.idealSwellMax) / 2
  const heightSpan = Math.max((spot.idealSwellMax - spot.idealSwellMin) / 2, 0.5)
  const heightFit = 1 - clamp(Math.abs(point.waveHeight - heightMid) / heightSpan, 0, 1)
  const periodFit = clamp((point.wavePeriod - 7) / Math.max(spot.idealPeriodMin - 7, 1), 0, 1)
  const windFit = 1 - clamp(point.windSpeed / 30, 0, 1)
  const offshoreFit = windAlignment(point.windDirection, spot.offshoreDirections)

  return Math.round((heightFit * 0.4 + periodFit * 0.25 + windFit * 0.15 + offshoreFit * 0.2) * 100)
}

export const summarizeDaily = (hourly: HourPoint[]): DaySummary[] => {
  const buckets = new Map<string, HourPoint[]>()

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
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return {
      date,
      label: dayLabel.format(new Date(date)),
      maxWaveHeight: Math.max(...points.map((point) => point.waveHeight)),
      minWaveHeight: Math.min(...points.map((point) => point.waveHeight)),
      maxSeaLevelHeight: tideHeights.length ? Math.max(...tideHeights) : null,
      minSeaLevelHeight: tideHeights.length ? Math.min(...tideHeights) : null,
      tideRange: tideHeights.length ? Math.max(...tideHeights) - Math.min(...tideHeights) : null,
      avgWavePeriod: points.reduce((sum, point) => sum + point.wavePeriod, 0) / points.length,
      avgWindSpeed: points.reduce((sum, point) => sum + point.windSpeed, 0) / points.length,
      bestScore: best.score,
      bestHour: hourLabel.format(new Date(best.time)),
      confidence: points.reduce((sum, point) => sum + point.confidence, 0) / points.length,
    }
  })
}

const summarizeTide = (hourly: HourPoint[]): TideSummary => {
  const extremes: TideSummary['upcoming'] = []
  for (let index = 1; index < hourly.length - 1; index += 1) {
    const previous = hourly[index - 1]?.seaLevelHeight
    const current = hourly[index]?.seaLevelHeight
    const next = hourly[index + 1]?.seaLevelHeight
    if (previous === null || previous === undefined || current === null || current === undefined || next === null || next === undefined) {
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

const blendOpenMeteo = ({ marine, weather, index, weatherIndex = index }: { marine: any; weather: any; index: number; weatherIndex?: number }) => {
  const waveEntries = [
    {
      label: 'Open-Meteo marine guidance',
      weight: 1,
      waveHeight: safeNumber(marine?.hourly?.wave_height?.[index]),
      wavePeriod: safeNumber(marine?.hourly?.wave_period?.[index]),
      waveDirection: safeNumber(marine?.hourly?.wave_direction?.[index]),
      swellWaveHeight: safeNumber(marine?.hourly?.swell_wave_height?.[index]),
      windWaveHeight: safeNumber(marine?.hourly?.wind_wave_height?.[index]),
      waterTemperature: safeNumber(marine?.hourly?.sea_surface_temperature?.[index]),
    },
  ]

  const weatherEntries = [
    {
      label: 'Open-Meteo weather guidance',
      weight: 1,
      windSpeed: safeNumber(weather?.hourly?.wind_speed_10m?.[weatherIndex]),
      windDirection: safeNumber(weather?.hourly?.wind_direction_10m?.[weatherIndex]),
      airTemperature: safeNumber(weather?.hourly?.temperature_2m?.[weatherIndex]),
    },
  ]

  return {
    waveEntries,
    weatherEntries,
    waveHeight: weightedAverage(waveEntries.map((entry) => ({ value: entry.waveHeight, weight: entry.weight }))),
    wavePeriod: weightedAverage(waveEntries.map((entry) => ({ value: entry.wavePeriod, weight: entry.weight }))),
    waveDirection: weightedDirection(waveEntries.map((entry) => ({ value: entry.waveDirection, weight: entry.weight }))),
    swellWaveHeight: weightedAverage(waveEntries.map((entry) => ({ value: entry.swellWaveHeight, weight: entry.weight }))),
    windWaveHeight: weightedAverage(waveEntries.map((entry) => ({ value: entry.windWaveHeight, weight: entry.weight }))),
    waterTemperature: weightedAverage(waveEntries.map((entry) => ({ value: entry.waterTemperature, weight: entry.weight }))),
    windSpeed: weightedAverage(weatherEntries.map((entry) => ({ value: entry.windSpeed, weight: entry.weight }))),
    windDirection: weightedDirection(weatherEntries.map((entry) => ({ value: entry.windDirection, weight: entry.weight }))),
    airTemperature: weightedAverage(weatherEntries.map((entry) => ({ value: entry.airTemperature, weight: entry.weight }))),
  }
}

const buildForecastFromResponses = ({ spot, marine, weather, tide, generatedAt }: { spot: Spot; marine: any; weather: any; tide: any; generatedAt: string }) => {
  const marineTimes = marine?.hourly?.time
  const weatherTimes = weather?.hourly?.time
  const tideTimes = tide?.hourly?.time ?? []
  if (!Array.isArray(marineTimes) || !marineTimes.length || !Array.isArray(weatherTimes) || !weatherTimes.length) {
    throw new Error(`No marine forecast returned for ${spot.name}`)
  }

  const tideSeaLevels = tide?.hourly?.sea_level_height_msl ?? []
  const weatherIndex = indexByTime(weatherTimes)
  const tideIndexByTime = indexByTime(tideTimes)
  const times = marineTimes.filter((time: string) => weatherIndex.has(time))
  if (!times.length) {
    throw new Error(`No overlapping marine/weather forecast times for ${spot.name}`)
  }

  const hourly = times.map((time: string) => {
    const marineIdx = marineTimes.indexOf(time)
    const weatherIdx = weatherIndex.get(time) as number
    const blend = blendOpenMeteo({ marine, weather, index: marineIdx, weatherIndex: weatherIdx })
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

    if (waveHeight === null || wavePeriod === null || waveDirection === null || windSpeed === null || windDirection === null || airTemperature === null) {
      throw new Error(`Incomplete blended forecast for ${spot.name} at ${time}`)
    }

    const heightSpread = stdev(waveEntries.map((entry) => entry.waveHeight))
    const periodSpread = stdev(waveEntries.map((entry) => entry.wavePeriod))
    const modelSpread = Number((heightSpread + periodSpread * 0.12).toFixed(2))
    const confidence = Math.round(clamp(100 - heightSpread * 18 - periodSpread * 4, 30, 98))
    const tideIndex = (tideIndexByTime.get(time) as number | undefined) ?? -1
    const seaLevelHeight = safeNumber(tideSeaLevels[tideIndex])
    const nextSeaLevelHeight = safeNumber(tideSeaLevels[tideIndex + 1])

    const pointBase = {
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
      ...pointBase,
      score: scoreHour(spot, pointBase),
    }
  })

  const current = hourly[0]
  const nextBestWindow = [...hourly].sort((a, b) => b.score - a.score)[0]

  return {
    spot,
    source: 'generated' as const,
    updatedAt: generatedAt,
    generatedAt,
    current,
    nextBestWindow,
    hourly,
    daily: summarizeDaily(hourly),
    tide: summarizeTide(hourly),
    buoy: null,
    modelBlend: {
      waveModels: ['Open-Meteo marine guidance'],
      weatherModels: ['Open-Meteo weather guidance'],
      notes: [
        'Live spot detail uses Open-Meteo marine and weather guidance directly in the browser.',
        'Tide proxy uses Open-Meteo sea level height above mean sea level; coastal accuracy is limited.',
        'Hourly score favors clean offshore wind plus target swell band.',
      ],
    },
  } satisfies ForecastPayload
}

export const loadMapDataset = async (): Promise<MapDataset> => {
  const response = await fetch(`${import.meta.env.BASE_URL}data/map-data.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error('Could not load map data package.')
  return (await response.json()) as MapDataset
}

export const loadLiveSpotForecast = async (spot: Spot): Promise<ForecastPayload> => {
  const marineUrl = new URL(marineBase)
  marineUrl.search = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    hourly: 'wave_height,wave_period,wave_direction,swell_wave_height,wind_wave_height,sea_surface_temperature',
    forecast_days: '8',
    timezone: 'UTC',
  }).toString()

  const weatherUrl = new URL(weatherBase)
  weatherUrl.search = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    hourly: 'wind_speed_10m,wind_direction_10m,temperature_2m',
    forecast_days: '8',
    timezone: 'UTC',
  }).toString()

  const tideUrl = new URL(marineBase)
  tideUrl.search = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    hourly: 'sea_level_height_msl',
    forecast_days: '8',
    timezone: 'UTC',
  }).toString()

  const [marine, weather, tide] = await Promise.all([
    fetch(marineUrl.toString()).then((response) => {
      if (!response.ok) throw new Error('Could not load live marine forecast.')
      return response.json()
    }),
    fetch(weatherUrl.toString()).then((response) => {
      if (!response.ok) throw new Error('Could not load live weather forecast.')
      return response.json()
    }),
    fetch(tideUrl.toString()).then((response) => {
      if (!response.ok) throw new Error('Could not load live tide forecast.')
      return response.json()
    }),
  ])

  return buildForecastFromResponses({ spot, marine, weather, tide, generatedAt: new Date().toISOString() })
}

export const findForecastBySpot = (spots: ForecastPayload[], spotId: string): ForecastPayload | null =>
  spots.find((spotForecast) => spotForecast.spot.id === spotId) ?? null

export const formatDirection = (degrees: number) => {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return labels[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]
}

export const formatHour = (iso: string) => hourLabel.format(new Date(iso))

export const describeScore = (score: number) => {
  if (score >= 80) return 'Epic'
  if (score >= 65) return 'Very Good'
  if (score >= 50) return 'Fun'
  if (score >= 35) return 'Fair'
  return 'Stormy'
}
