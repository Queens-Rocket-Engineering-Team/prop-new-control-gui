// N2O saturation line - baked NIST table, never fetched at runtime.
//
// Source: NIST Chemistry WebBook, Thermophysical Properties of Fluid Systems,
//   nitrous oxide, CAS 10024-97-2 (NIST fluid ID C10024972), saturation
//   properties. Underlying EOS: Span & Wagner (2003), via NIST REFPROP.
// Retrieved 2026-08-16 from:
//   https://webbook.nist.gov/cgi/fluid.cgi?Action=Data&Wide=on&ID=C10024972
//     &Type=SatT&Digits=5&TLow=-90&THigh=36&TInc=1&RefState=DEF&TUnit=C&PUnit=psia
//     &DUnit=kg%2Fm3&HUnit=kJ%2Fkg&WUnit=m%2Fs&VisUnit=uPa*s&STUnit=N%2Fm
//
// The fetch returned 601 rows spanning the triple point to the critical point at
// uniform *pressure* steps (so dT varies: ~0.1 C near ambient, ~2 C down at the
// triple point). Every 5th row is kept here - 121 rows, both endpoints exact.
// That stride was chosen by measurement, not by eye: interpolating the reduced
// table and scoring it against the 480 dropped rows over -45..40 C gives a worst
// case of 0.065 psi and 0.0045 C. scripts/check_n2o_saturation.mjs re-checks a
// sample of those dropped rows so the claim cannot rot.
//
// Do NOT re-fetch at runtime. Pad tablets are served from nginx behind no WAN,
// and a saturation curve that silently fails to load is worse than none.

/** Triple point (NIST). Below this the saturation line does not exist. */
export const N2O_TRIPLE_C = -90.82
export const N2O_TRIPLE_PSIA = 12.74

/** Critical point (NIST). Above this there is no liquid/vapour distinction. */
export const N2O_CRITICAL_C = 36.37
export const N2O_CRITICAL_PSIA = 1050.8

/** Standard atmosphere, psi. PT202 reads gauge; the table is absolute. */
export const PSI_PER_ATM = 14.696

/**
 * Saturation temperatures, degrees C, strictly ascending.
 * Parallel to SAT_P_PSIA - two flat arrays rather than an array of pairs so a
 * lookup allocates nothing. This runs on every telemetry publish (~15 Hz).
 */
const SAT_T_C = Object.freeze([
  -90.82, -81.931, -75.539, -70.449, -66.171, -62.454, -59.152, -56.168,
  -53.439, -50.919, -48.572, -46.374, -44.303, -42.344, -40.482, -38.708,
  -37.011, -35.385, -33.822, -32.317, -30.865, -29.462, -28.104, -26.788,
  -25.51, -24.269, -23.061, -21.885, -20.739, -19.621, -18.529, -17.463,
  -16.419, -15.399, -14.4, -13.421, -12.461, -11.52, -10.596, -9.6894,
  -8.7989, -7.9238, -7.0637, -6.2178, -5.3856, -4.5667, -3.7605, -2.9666,
  -2.1846, -1.414, -0.65452, 0.094285, 0.83273, 1.5611, 2.2798, 2.9891,
  3.6892, 4.3804, 5.063, 5.7372, 6.4032, 7.0613, 7.7116, 8.3545,
  8.99, 9.6183, 10.24, 10.854, 11.462, 12.064, 12.659, 13.247,
  13.83, 14.407, 14.978, 15.544, 16.103, 16.658, 17.207, 17.751,
  18.289, 18.823, 19.351, 19.875, 20.394, 20.909, 21.418, 21.923,
  22.424, 22.92, 23.412, 23.9, 24.384, 24.863, 25.338, 25.809,
  26.277, 26.74, 27.2, 27.655, 28.107, 28.555, 29, 29.44,
  29.877, 30.311, 30.741, 31.167, 31.589, 32.008, 32.424, 32.836,
  33.244, 33.649, 34.05, 34.447, 34.841, 35.23, 35.616, 35.996,
  36.37,
])

/** Saturation pressures, psia, strictly ascending (dP/dT > 0 along the line). */
const SAT_P_PSIA = Object.freeze([
  12.74, 21.391, 30.041, 38.692, 47.342, 55.993, 64.643, 73.294,
  81.944, 90.594, 99.245, 107.9, 116.55, 125.2, 133.85, 142.5,
  151.15, 159.8, 168.45, 177.1, 185.75, 194.4, 203.05, 211.7,
  220.35, 229, 237.65, 246.3, 254.95, 263.6, 272.25, 280.91,
  289.56, 298.21, 306.86, 315.51, 324.16, 332.81, 341.46, 350.11,
  358.76, 367.41, 376.06, 384.71, 393.36, 402.01, 410.66, 419.31,
  427.96, 436.61, 445.26, 453.91, 462.57, 471.22, 479.87, 488.52,
  497.17, 505.82, 514.47, 523.12, 531.77, 540.42, 549.07, 557.72,
  566.37, 575.02, 583.67, 592.32, 600.97, 609.62, 618.27, 626.92,
  635.58, 644.23, 652.88, 661.53, 670.18, 678.83, 687.48, 696.13,
  704.78, 713.43, 722.08, 730.73, 739.38, 748.03, 756.68, 765.33,
  773.98, 782.63, 791.28, 799.93, 808.58, 817.24, 825.89, 834.54,
  843.19, 851.84, 860.49, 869.14, 877.79, 886.44, 895.09, 903.74,
  912.39, 921.04, 929.69, 938.34, 946.99, 955.64, 964.29, 972.94,
  981.59, 990.25, 998.9, 1007.5, 1016.2, 1024.8, 1033.5, 1042.1,
  1050.8,
])

/** ln(P), precomputed once - see the interpolation note on pSatFromT. */
const SAT_LN_P = Object.freeze(SAT_P_PSIA.map(Math.log))

export const N2O_RANGE = Object.freeze({
  tMinC: N2O_TRIPLE_C,
  tMaxC: N2O_CRITICAL_C,
  pMinPsia: N2O_TRIPLE_PSIA,
  pMaxPsia: N2O_CRITICAL_PSIA,
})

/** Index i with arr[i] <= x < arr[i + 1], clamped to a usable interval. */
function bracket(arr, x) {
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return Math.min(Math.max(lo - 1, 0), arr.length - 2)
}

// Both lookups interpolate ln(P) linearly in T rather than P linearly in T.
// Vapour pressure is close to exponential in temperature, so the log makes the
// segments nearly straight: on this table it cuts the worst-case error from
// 0.013 C to 0.0045 C for one Math.exp. Full Clausius-Clapeyron (1/T_K vs ln P)
// was measured too and buys nothing at this spacing.
//
// Note the two functions share that one interpolant, so they are exact inverses
// of each other to machine precision. A round-trip test therefore proves the
// algebra and says nothing about accuracy - that needs NIST rows this table does
// not contain. See scripts/check_n2o_saturation.mjs.

/**
 * Saturation pressure at a temperature.
 * @param {number} tC degrees C
 * @returns {number|null} psia, or null outside [triple, critical]
 */
export function pSatFromT(tC) {
  if (!Number.isFinite(tC) || tC < N2O_TRIPLE_C || tC > N2O_CRITICAL_C) return null
  const i = bracket(SAT_T_C, tC)
  const f = (tC - SAT_T_C[i]) / (SAT_T_C[i + 1] - SAT_T_C[i])
  return Math.exp(SAT_LN_P[i] + f * (SAT_LN_P[i + 1] - SAT_LN_P[i]))
}

/**
 * Saturation temperature at an ABSOLUTE pressure. Callers holding a gauge
 * reading must add PSI_PER_ATM first.
 * @param {number} pPsia psia
 * @returns {number|null} degrees C, or null outside [triple, critical]
 */
export function tSatFromP(pPsia) {
  if (!Number.isFinite(pPsia) || pPsia < N2O_TRIPLE_PSIA || pPsia > N2O_CRITICAL_PSIA) return null
  const i = bracket(SAT_P_PSIA, pPsia)
  const f = (Math.log(pPsia) - SAT_LN_P[i]) / (SAT_LN_P[i + 1] - SAT_LN_P[i])
  return SAT_T_C[i] + f * (SAT_T_C[i + 1] - SAT_T_C[i])
}

/**
 * The saturation line as a polyline, clipped to a temperature window, with the
 * window edges landing exactly on the boundary rather than on the nearest table
 * row. For drawing only.
 * @param {number} tMinC
 * @param {number} tMaxC
 * @returns {Array<[number, number]>} [[tC, pPsia], ...] ascending in T
 */
export function saturationCurve(tMinC, tMaxC) {
  const lo = Math.max(tMinC, N2O_TRIPLE_C)
  const hi = Math.min(tMaxC, N2O_CRITICAL_C)
  if (!(hi > lo)) return []

  const pts = [[lo, pSatFromT(lo)]]
  for (let i = 0; i < SAT_T_C.length; i++) {
    if (SAT_T_C[i] > lo && SAT_T_C[i] < hi) pts.push([SAT_T_C[i], SAT_P_PSIA[i]])
  }
  pts.push([hi, pSatFromT(hi)])
  return pts
}
