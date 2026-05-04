export type SkillLevel = 'Beginner' | 'Intermediate' | 'Advanced'
export type CrowdLevel = 'Low' | 'Medium' | 'High'

export type Spot = {
  id: string
  name: string
  region: string
  country: string
  latitude: number
  longitude: number
  idealSwellMin: number
  idealSwellMax: number
  idealPeriodMin: number
  offshoreDirections: number[]
  skill: SkillLevel
  tideWindow: string
  boardHint: string
  crowd: CrowdLevel
  buoyStationId?: string
  buoyName?: string
  webcamUrl?: string
  timezone?: string
  surflineSpotId?: string
}

export type TideTrend = 'rising' | 'falling' | 'slack'

export type TideExtreme = {
  time: string
  type: 'high' | 'low'
  seaLevelHeight: number
}

export type TideSummary = {
  currentSeaLevelHeight: number | null
  currentTrend: TideTrend
  nextHigh: TideExtreme | null
  nextLow: TideExtreme | null
  upcoming: TideExtreme[]
}

export type BuoyObservation = {
  stationId: string
  stationName?: string
  observedAt: string
  waveHeight?: number | null
  dominantPeriod?: number | null
  averagePeriod?: number | null
  meanWaveDirection?: number | null
  windSpeed?: number | null
  windDirection?: number | null
  airTemperature?: number | null
  waterTemperature?: number | null
}

export type ModelInstant = {
  key: string
  label: string
  waveHeight?: number | null
  wavePeriod?: number | null
  waveDirection?: number | null
  windSpeed?: number | null
  windDirection?: number | null
}

export type HourPoint = {
  time: string
  waveHeight: number
  wavePeriod: number
  waveDirection: number
  windSpeed: number
  windDirection: number
  airTemperature: number
  waterTemperature: number
  seaLevelHeight: number | null
  tideTrend: TideTrend
  swellWaveHeight?: number | null
  windWaveHeight?: number | null
  score: number
  confidence: number
  modelSpread: number
}

export type DaySummary = {
  date: string
  label: string
  maxWaveHeight: number
  minWaveHeight: number
  maxSeaLevelHeight: number | null
  minSeaLevelHeight: number | null
  tideRange: number | null
  avgWavePeriod: number
  avgWindSpeed: number
  bestScore: number
  bestHour: string
  confidence: number
}

export type ForecastPayload = {
  spot: Spot
  source: 'generated'
  updatedAt: string
  generatedAt: string
  current: HourPoint
  nextBestWindow: HourPoint
  hourly: HourPoint[]
  daily: DaySummary[]
  tide: TideSummary
  buoy?: BuoyObservation | null
  modelBlend: {
    waveModels: string[]
    weatherModels: string[]
    notes: string[]
  }
}

export type MapFieldPoint = {
  latitude: number
  longitude: number
  waveHeight: number
  waveDirection: number
  wavePeriod: number
  windSpeed: number
  windDirection: number
  seaLevelHeight: number | null
  tideTrend: TideTrend
}

export type VelocityRecordHeader = {
  parameterCategory: number
  parameterNumber: number
  nx: number
  ny: number
  lo1: number
  la1: number
  lo2: number
  la2: number
  dx: number
  dy: number
  refTime: string
}

export type VelocityRecord = {
  header: VelocityRecordHeader
  data: number[]
}

export type SpotSummary = {
  spot: Spot
  source: 'generated'
  updatedAt: string
  generatedAt: string
  current: HourPoint
  nextBestWindow: HourPoint
  tide: TideSummary
  modelBlend: {
    waveModels: string[]
    weatherModels: string[]
    notes: string[]
  }
}

export type MapDataset = {
  generatedAt: string
  source: 'generated'
  spots: SpotSummary[]
  mapField: {
    generatedAt: string
    points: MapFieldPoint[]
    velocityData: VelocityRecord[]
  }
  research: {
    modelingNotes: string[]
    analysisDataSources: string[]
  }
}
