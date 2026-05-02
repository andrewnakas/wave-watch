import type { DaySummary, ForecastCollection, ForecastPayload, HourPoint, Spot } from '../types'

const hourLabel = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const circularDistance = (a: number, b: number) => {
  const delta = Math.abs(a - b) % 360
  return Math.min(delta, 360 - delta)
}

const windAlignment = (windDirection: number, offshoreDirections: number[]) => {
  const bestDistance = Math.min(
    ...offshoreDirections.map((dir) => circularDistance(dir, windDirection)),
  )
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

export const loadForecastCollection = async (): Promise<ForecastCollection> => {
  const response = await fetch(`${import.meta.env.BASE_URL}data/forecast-data.json`, {
    cache: 'no-cache',
  })

  if (!response.ok) {
    throw new Error('Could not load generated forecast data.')
  }

  return (await response.json()) as ForecastCollection
}

export const findForecastBySpot = (
  collection: ForecastCollection,
  spotId: string,
): ForecastPayload | null =>
  collection.spots.find((spotForecast) => spotForecast.spot.id === spotId) ?? null

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
