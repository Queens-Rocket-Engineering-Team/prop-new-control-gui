/**
 * Convert either session-component representation used by prop-teststand into
 * one stable shape for the UI.
 *
 * `/ws/state` uses strings (for example, `"ok"`) while the sessions HTTP API
 * uses `{ status, detail }` objects. Unknown/malformed values remain visible as
 * `unknown` instead of being treated as healthy.
 *
 * @param {unknown} component
 * @returns {{status: string, detail: unknown}}
 */
export function normalizeSessionComponent(component) {
  if (typeof component === 'string') {
    return { status: component || 'unknown', detail: null }
  }

  if (component && typeof component === 'object' && !Array.isArray(component)) {
    return {
      ...component,
      status: typeof component.status === 'string' && component.status
        ? component.status
        : 'unknown',
      detail: component.detail ?? null,
    }
  }

  return { status: 'unknown', detail: null }
}

/**
 * Normalize all component values on a session without otherwise changing its
 * server-provided metadata.
 *
 * @param {unknown} value
 * @returns {Record<string, {status: string, detail: unknown}>}
 */
export function normalizeSessionComponents(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value).map(([name, component]) => [
      name,
      normalizeSessionComponent(component),
    ])
  )
}
