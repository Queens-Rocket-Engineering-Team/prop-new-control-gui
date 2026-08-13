// Tolerant GPS coordinate parsing for the map "go to coordinates" box.
//
// Accepts, in one string:
//   decimal:  "47.9657, -81.8729"   "47.9657 -81.8729"
//   DMS:      47°57'56.4"N 81°52'22.4"W   (also ′ ″ unicode marks, extra
//             spaces, or bare "47 57 56.4 N 81 52 22.4 W")
//   mixed hemisphere letters before or after each part.
//
// Returns { lat, lon } or null when the string doesn't parse.

// One coordinate part: degrees [minutes [seconds]] with optional decimal on
// the last present component, optional sign, optional hemisphere letter on
// either side.
const PART = String.raw`([NSEW])?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[°º\s]\s*(\d+(?:\.\d+)?))?(?:\s*['′\s]\s*(\d+(?:\.\d+)?))?\s*["″]?\s*([NSEW])?`
const PAIR_RE = new RegExp(
  String.raw`^\s*${PART}\s*[,;\s]\s*${PART}\s*$`,
  'i',
)

function toSigned(deg, min, sec, hemiA, hemiB) {
  let value = Math.abs(deg) + (min ?? 0) / 60 + (sec ?? 0) / 3600
  const hemi = (hemiA || hemiB || '').toUpperCase()
  const negative = deg < 0 || Object.is(deg, -0) || hemi === 'S' || hemi === 'W'
  return { value: negative ? -value : value, hemi }
}

export function parseCoords(text) {
  if (typeof text !== 'string') return null
  const m = PAIR_RE.exec(text.trim())
  if (!m) return null

  const [, aH1, aDeg, aMin, aSec, aH2, bH1, bDeg, bMin, bSec, bH2] = m
  const a = toSigned(parseFloat(aDeg), aMin && parseFloat(aMin), aSec && parseFloat(aSec), aH1, aH2)
  const b = toSigned(parseFloat(bDeg), bMin && parseFloat(bMin), bSec && parseFloat(bSec), bH1, bH2)

  // Assign parts to lat/lon: hemisphere letters win; otherwise first is lat.
  let lat, lon
  if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S') {
    lat = b.value
    lon = a.value
  } else {
    lat = a.value
    lon = b.value
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}
