import { computed, unref } from 'vue'

/**
 * Sensor-group registry.
 *
 * Every device publishes its sensors under a group key taken straight from its
 * QLCP config (`"sensors": { "<group>": { "<sensor>": {...} } }`).  That key
 * arrives on the frontend as `devices[].sensors[].sensor_type` and — when the
 * server includes it — as `sensor_type` on telemetry display readings.
 *
 * Prop boards use the sensor-category groups (pressure_transducer, …); the
 * avionics ground-station relay (GREG) uses functional groups (rocket_position,
 * rocket_link, …).  Order below defines display order everywhere.
 */

export const OTHER_GROUP_KEY = 'other'

export const SENSOR_GROUPS = [
  { key: 'pressure_transducer', label: 'Pressure',        color: '#3498db' },
  { key: 'thermocouple',        label: 'Temperature',     color: '#e74c3c' },
  { key: 'load_cell',           label: 'Load Cell',       color: '#2ecc71' },
  { key: 'current_sensor',      label: 'Current',         color: '#f39c12' },
  { key: 'resistance_sensor',   label: 'Resistance',      color: '#1abc9c' },
  { key: 'rocket_position',     label: 'Rocket Position', color: '#9b59b6' },
  { key: 'rocket_nodes',        label: 'Rocket Nodes',    color: '#e84393' },
  { key: 'rocket_link',         label: 'Rocket Link',     color: '#0abde3' },
  { key: 'rocket_radio_config', label: 'Radio Config',    color: '#6c7ae0' },
  { key: 'ground_station',      label: 'Ground Station',  color: '#d35400' },
  { key: 'voltage_sense',       label: 'Voltage Sense',   color: '#b7950b' },
  { key: OTHER_GROUP_KEY,       label: 'Other',           color: '#95a5a6' },
]

const GROUP_MAP   = Object.fromEntries(SENSOR_GROUPS.map((g) => [g.key, g]))
const GROUP_ORDER = Object.fromEntries(SENSOR_GROUPS.map((g, i) => [g.key, i]))

// Unknown groups sort after every registered group but before "Other".
const UNKNOWN_ORDER = SENSOR_GROUPS.length - 1.5

// Colours handed out to group keys the registry does not know about, so a new
// server-side group still gets a stable, distinguishable colour without a
// frontend change.
const FALLBACK_COLORS = ['#8e44ad', '#16a085', '#2980b9', '#c0392b', '#7f8c8d', '#e67e22']

function hashCode(str) {
  let h = 0
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

function prettifyGroupKey(key) {
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Display metadata for a group key — synthesised for unregistered keys.
 * @param {string} key
 * @returns {{ key: string, label: string, color: string, order: number }}
 */
export function groupMeta(key) {
  const normalized = String(key ?? '').trim() || OTHER_GROUP_KEY
  const known = GROUP_MAP[normalized]
  if (known) return { ...known, order: GROUP_ORDER[normalized] }
  return {
    key:   normalized,
    label: prettifyGroupKey(normalized),
    color: FALLBACK_COLORS[hashCode(normalized) % FALLBACK_COLORS.length],
    order: UNKNOWN_ORDER,
  }
}

export function groupLabel(key) {
  return groupMeta(key).label
}

export function normalizeId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

// Last-resort classification for streams that arrive before (or without) any
// device config — the legacy PT/TC/LC naming convention.
function groupFromName(name) {
  const u = String(name ?? '').toUpperCase()
  if (u.startsWith('PT')) return 'pressure_transducer'
  if (u.startsWith('TC')) return 'thermocouple'
  if (u.startsWith('LC')) return 'load_cell'
  return OTHER_GROUP_KEY
}

/**
 * Resolve a stream's group key, most authoritative source first.
 * @param {string} name                     sensor name
 * @param {string|undefined} streamGroup    group reported on the telemetry reading
 * @param {Record<string,string>} deviceMap normalizedName → group from device configs
 */
export function resolveGroupKey(name, streamGroup, deviceMap = {}) {
  const fromStream = String(streamGroup ?? '').trim()
  if (fromStream) return fromStream

  const fromDevice = deviceMap[normalizeId(name)]
  if (fromDevice) return fromDevice

  return groupFromName(name)
}

/**
 * Groups live telemetry streams using the device configs as the group source.
 *
 * @param {import('vue').Ref<Record<string,object>>} sensorData
 * @param {import('vue').Ref<object[]>} devices
 * @returns {{
 *   deviceGroupByName: import('vue').ComputedRef<Record<string,string>>,
 *   groupByName:       import('vue').ComputedRef<Record<string,string>>,
 *   groups:            import('vue').ComputedRef<{key:string,label:string,color:string,streams:string[]}[]>,
 * }}
 */
export function useSensorGroups(sensorData, devices) {
  // normalizedSensorName → group key, from every device's published config
  const deviceGroupByName = computed(() => {
    const map = {}
    for (const dev of (unref(devices) ?? [])) {
      for (const sensor of (dev?.sensors ?? [])) {
        const name  = String(sensor?.name ?? '').trim()
        const group = String(sensor?.sensor_type ?? sensor?.type ?? '').trim()
        if (!name || !group) continue
        map[normalizeId(name)] = group
      }
    }
    return map
  })

  // sensorName → group key, for every stream currently carrying data
  const groupByName = computed(() => {
    const map = {}
    for (const [name, info] of Object.entries(unref(sensorData) ?? {})) {
      map[name] = resolveGroupKey(name, info?.sensorType, deviceGroupByName.value)
    }
    return map
  })

  // Ordered groups, each with its alphabetically sorted stream names
  const groups = computed(() => {
    const byGroup = new Map()
    for (const [name, key] of Object.entries(groupByName.value)) {
      if (!byGroup.has(key)) byGroup.set(key, [])
      byGroup.get(key).push(name)
    }

    return [...byGroup.entries()]
      .map(([key, streams]) => ({
        ...groupMeta(key),
        streams: streams.sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label))
  })

  return { deviceGroupByName, groupByName, groups }
}
