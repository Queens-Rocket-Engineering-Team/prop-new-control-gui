import { ref, watch } from 'vue'

// Accumulates the rocket's GPS track for the flight panel map.
//
// GPS arrives as independent scalar streams on the display telemetry socket
// (sensor names `Lat` / `Lon` / `Alt` / `Sats`, group `rocket_position`, from
// the GREG ground station) — there is no structured fix object on the wire.
// This composable pairs the latest Lat/Lon per display batch into a fix and
// appends it to an unpruned trail buffer. It exists because sensorData
// history is hard-pruned to the rolling telemetry window (30 s), while the
// flight trail must span the whole flight.
//
// Sensor names are globally unique in sensorData (Lat/Lon only ever come
// from GREG), so no device/group filtering is needed here.

const MAX_TRAIL_POINTS = 50_000 // safety valve: >3 h of 4 Hz fixes
const TRAIL_CHOP = 1_000        // points dropped from the head when the cap is hit
const BEARING_MIN_MOVE_M = 1.5  // ignore sub-GPS-noise moves so the marker doesn't spin at rest
const EARTH_RADIUS_M = 6_371_000

function bearingDeg(a, b) {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const θ = Math.atan2(
    Math.sin(Δλ) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ),
  )
  return ((θ * 180) / Math.PI + 360) % 360
}

// Equirectangular approximation — plenty accurate at flight-track distances.
function distanceMeters(a, b) {
  const φm = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const dx = ((b.lon - a.lon) * Math.PI / 180) * Math.cos(φm)
  const dy = ((b.lat - a.lat) * Math.PI) / 180
  return EARTH_RADIUS_M * Math.sqrt(dx * dx + dy * dy)
}

export function useFlightTrack(sensorData, { testActive } = {}) {
  // Trail coordinates as [lon, lat, alt] triples. Deliberately non-reactive:
  // consumers are told about changes via trailVersion and pull a snapshot
  // with getTrailGeoJSON() (same publish pattern as useTelemetryStream).
  let _coords = []
  let _lastFixT = -Infinity

  const currentFix = ref(null) // { lat, lon, alt, sats, t }
  const bearing = ref(0)       // degrees clockwise from north
  const trailVersion = ref(0)

  function getTrailGeoJSON() {
    // Returns the live array for cheap map.setData() calls — callers must
    // treat the coordinates as read-only.
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: _coords },
    }
  }

  function reset() {
    _coords = []
    _lastFixT = -Infinity
    currentFix.value = null
    bearing.value = 0
    trailVersion.value++
  }

  watch(sensorData, (snap) => {
    const latEntry = snap?.Lat
    const lonEntry = snap?.Lon
    if (!latEntry || !lonEntry) return

    const lat = Number(latEntry.value)
    const lon = Number(lonEntry.value)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    if (lat === 0 && lon === 0) return // no-lock sentinel

    // Snapshots always contain every known sensor, so skip batches where the
    // GPS streams didn't actually produce a new point.
    const t = latEntry.history.at(-1)?.sourceT ?? latEntry.windowEnd
    if (t <= _lastFixT) return
    _lastFixT = t

    const alt = Number.isFinite(Number(snap.Alt?.value)) ? Number(snap.Alt.value) : null
    const sats = Number.isFinite(Number(snap.Sats?.value)) ? Number(snap.Sats.value) : null

    const prev = currentFix.value
    if (prev && prev.lat === lat && prev.lon === lon) {
      // Position unchanged: refresh the ancillary fields, keep the trail as is.
      currentFix.value = { ...prev, alt: alt ?? prev.alt, sats: sats ?? prev.sats, t }
      return
    }

    if (prev && distanceMeters(prev, { lat, lon }) > BEARING_MIN_MOVE_M) {
      bearing.value = bearingDeg(prev, { lat, lon })
    }

    _coords.push([lon, lat, alt ?? 0])
    if (_coords.length > MAX_TRAIL_POINTS) _coords.splice(0, TRAIL_CHOP)
    currentFix.value = { lat, lon, alt, sats, t }
    trailVersion.value++
  })

  if (testActive) {
    watch(testActive, (active, wasActive) => {
      if (active && !wasActive) reset() // new test → fresh trail, in every window
    })
  }

  return { currentFix, bearing, trailVersion, getTrailGeoJSON, reset }
}
