import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const spotsPath = path.join(root, 'src', 'data', 'spots.json')
const baseSpotsPath = process.env.BASE_SPOTS_PATH ? path.resolve(root, process.env.BASE_SPOTS_PATH) : spotsPath
const zoneTabPath = '/usr/share/zoneinfo/zone1970.tab'
const targetCount = Number(process.env.TARGET_SPOTS || 1200)
const tileStep = Number(process.env.SURFLINE_TILE_STEP || 15)
const nearDuplicateRadiusKm = Number(process.env.NEAR_DUPLICATE_RADIUS_KM || 1.5)
const nearbySameNameRadiusKm = Number(process.env.NEARBY_SAME_NAME_RADIUS_KM || 10)
const maxLatitude = Number(process.env.MAX_LATITUDE || 60)
const minLatitude = Number(process.env.MIN_LATITUDE || -60)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const safeNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const normalizeName = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const slugify = (value) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)

const toRadians = (degrees) => (degrees * Math.PI) / 180
const distanceKm = (a, b) => {
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)
  const dLat = lat2 - lat1
  const dLon = toRadians(b.longitude - a.longitude)
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

const countryNameFromCode = (code) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

const loadTimezoneCountryMap = async () => {
  const raw = await readFile(zoneTabPath, 'utf8')
  const map = new Map()
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const [countryCodes, , zone] = line.split('\t')
    if (!zone || !countryCodes) continue
    const firstCode = countryCodes.split(',')[0]
    map.set(zone, countryNameFromCode(firstCode))
  }
  return map
}

const fetchJsonWithRetry = async (url, retries = 5) => {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'wave-watch-spot-sync/1.0' },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`)
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await sleep(350 * attempt)
      }
    }
  }
  throw lastError
}

const buildSurflineBoxes = () => {
  const boxes = []
  for (let south = minLatitude; south < maxLatitude; south += tileStep) {
    const north = Math.min(maxLatitude + tileStep, south + tileStep)
    for (let west = -180; west < 180; west += tileStep) {
      boxes.push({ north, east: west + tileStep, south, west })
    }
  }
  return boxes
}

const harvestSurflineSpots = async () => {
  const boxes = buildSurflineBoxes()
  const spots = new Map()

  for (const [index, box] of boxes.entries()) {
    const url = new URL('https://services.surfline.com/kbyg/mapview')
    url.search = new URLSearchParams({
      north: String(box.north),
      east: String(box.east),
      south: String(box.south),
      west: String(box.west),
    }).toString()
    const payload = await fetchJsonWithRetry(url)
    for (const spot of payload?.data?.spots ?? []) {
      spots.set(spot._id, spot)
    }
    if ((index + 1) % 20 === 0) {
      console.log(`Harvested ${index + 1}/${boxes.length} tiles -> ${spots.size} unique Surfline spots`)
    }
  }

  return [...spots.values()]
}

const strongestSwell = (spot) => {
  const swells = Array.isArray(spot?.swells) ? spot.swells : []
  return (
    swells
      .filter((entry) => safeNumber(entry?.period) !== null && safeNumber(entry?.direction) !== null)
      .sort((a, b) => (safeNumber(b.power) ?? 0) - (safeNumber(a.power) ?? 0))[0] ?? null
  )
}

const deriveSkill = (spot) => {
  const levels = Array.isArray(spot?.abilityLevels) ? spot.abilityLevels.map(String) : []
  if (levels.some((level) => /beginner/i.test(level))) return 'Beginner'
  if (levels.some((level) => /advanced|expert|pro/i.test(level))) return 'Advanced'
  return 'Intermediate'
}

const deriveBoardHint = (spot, swell) => {
  const boardTypes = Array.isArray(spot?.boardTypes) ? spot.boardTypes.map(String) : []
  const joined = boardTypes.join(' ').toLowerCase()
  if (joined.includes('longboard')) return 'Longboard'
  if (joined.includes('fish')) return 'Fish or groveler'
  if (joined.includes('gun') || joined.includes('step')) return 'Step-up shortboard'
  if ((safeNumber(swell?.period) ?? 0) >= 12) return 'Performance shortboard'
  if ((safeNumber(swell?.period) ?? 0) <= 9) return 'Fish or longboard'
  return 'Everyday shortboard'
}

const deriveCrowd = (spot) => {
  const cameraCount = (spot?.cameras?.length ?? 0) + (spot?.internalCameras?.length ?? 0)
  const rank = safeNumber(Array.isArray(spot?.rank) ? spot.rank[0] : null) ?? 0
  if (cameraCount >= 2 || rank >= 80) return 'High'
  if (cameraCount >= 1 || rank >= 35) return 'Medium'
  return 'Low'
}

const deriveIdealBand = (skill, swell) => {
  const basePeriod = clamp(Math.round(safeNumber(swell?.period) ?? 10), 8, 16)
  if (skill === 'Beginner') {
    return { idealSwellMin: 0.6, idealSwellMax: 1.8, idealPeriodMin: Math.min(basePeriod, 10) }
  }
  if (skill === 'Advanced') {
    return { idealSwellMin: 1.2, idealSwellMax: 4.0, idealPeriodMin: Math.max(basePeriod, 11) }
  }
  return { idealSwellMin: 0.8, idealSwellMax: 2.8, idealPeriodMin: Math.max(basePeriod, 9) }
}

const deriveOffshoreDirections = (spot, swell) => {
  const baseDirection =
    safeNumber(swell?.direction) !== null
      ? (swell.direction + 180) % 360
      : safeNumber(spot?.wind?.direction) !== null
        ? spot.wind.direction
        : 90
  return [-15, 0, 15].map((offset) => Math.round((baseDirection + offset + 360) % 360))
}

const deriveTideWindow = (spot) => {
  const tideType = String(spot?.tide?.current?.type ?? '').toLowerCase()
  if (tideType.includes('low')) return 'Low to mid tide'
  if (tideType.includes('high')) return 'Mid to high tide'
  return 'Mid tide'
}

const scoreSpot = (spot) => {
  const cameraCount = (spot?.cameras?.length ?? 0) + (spot?.internalCameras?.length ?? 0)
  const rank = safeNumber(Array.isArray(spot?.rank) ? spot.rank[0] : null) ?? 0
  const rating = safeNumber(spot?.rating?.value) ?? 0
  const relivable = safeNumber(spot?.relivableRating) ?? 0
  return cameraCount * 10 + rank + rating * 5 + relivable * 2
}

const isNearExisting = (candidate, existing) => {
  const km = distanceKm(candidate, existing)
  if (km <= nearDuplicateRadiusKm) return true
  return km <= nearbySameNameRadiusKm && normalizeName(candidate.name) === normalizeName(existing.name)
}

const transformSpot = (spot, timezoneCountryMap, usedIds) => {
  const swell = strongestSwell(spot)
  const skill = deriveSkill(spot)
  const idealBand = deriveIdealBand(skill, swell)
  const region = spot?.subregion?.name || 'Surfline'
  const country = timezoneCountryMap.get(spot?.timezone) || 'Unknown'
  const idSeeds = [spot.name, region, country]
  let id = slugify(idSeeds.filter(Boolean).join('-')) || `surfline-${spot._id}`
  let suffix = 2
  while (usedIds.has(id)) {
    id = `${slugify(idSeeds.filter(Boolean).join('-'))}-${suffix}`
    suffix += 1
  }
  usedIds.add(id)

  return {
    id,
    name: spot.name,
    region,
    country,
    latitude: Number(spot.lat.toFixed(4)),
    longitude: Number(spot.lon.toFixed(4)),
    ...idealBand,
    offshoreDirections: deriveOffshoreDirections(spot, swell),
    skill,
    tideWindow: deriveTideWindow(spot),
    boardHint: deriveBoardHint(spot, swell),
    crowd: deriveCrowd(spot),
    timezone: spot.timezone || undefined,
    surflineSpotId: spot._id || undefined,
    webcamUrl: Array.isArray(spot.cameras) && spot.cameras[0]?.streamUrl ? spot.cameras[0].streamUrl : undefined,
  }
}

const main = async () => {
  const existing = JSON.parse(await readFile(baseSpotsPath, 'utf8'))
  const timezoneCountryMap = await loadTimezoneCountryMap()
  const usedIds = new Set(existing.map((spot) => spot.id))
  const harvested = await harvestSurflineSpots()

  const existingCoords = existing.map((spot) => ({
    name: spot.name,
    latitude: spot.latitude,
    longitude: spot.longitude,
  }))

  const candidateSurflineSpots = harvested
    .filter((spot) => safeNumber(spot?.lat) !== null && safeNumber(spot?.lon) !== null && spot?.name)
    .sort((a, b) => scoreSpot(b) - scoreSpot(a) || String(a.name).localeCompare(String(b.name)))

  const additions = []
  for (const candidate of candidateSurflineSpots) {
    const probe = {
      name: candidate.name,
      latitude: candidate.lat,
      longitude: candidate.lon,
    }
    if (existingCoords.some((spot) => isNearExisting(probe, spot))) continue
    const transformed = transformSpot(candidate, timezoneCountryMap, usedIds)
    existingCoords.push({
      name: transformed.name,
      latitude: transformed.latitude,
      longitude: transformed.longitude,
    })
    additions.push(transformed)
    if (existing.length + additions.length >= targetCount) break
  }

  const merged = [...existing, ...additions]
  await writeFile(spotsPath, `${JSON.stringify(merged, null, 2)}\n`)
  console.log(`Wrote ${merged.length} spots (${existing.length} existing + ${additions.length} new)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
