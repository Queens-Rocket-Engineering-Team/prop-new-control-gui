// Checks for the baked N2O saturation table. There is no test runner in this
// repo, so this is a plain script:
//
//   node scripts/check_n2o_saturation.mjs
//
// It imports src/lib/n2oSaturation.js directly, which is possible only because
// that module has no Vue dependency - that is the reason it lives in src/lib
// rather than next to the component that draws it.

import assert from 'node:assert/strict'
import {
  pSatFromT,
  tSatFromP,
  saturationCurve,
  N2O_TRIPLE_C,
  N2O_TRIPLE_PSIA,
  N2O_CRITICAL_C,
  N2O_CRITICAL_PSIA,
  PSI_PER_ATM,
  psigOf,
  psiaOf,
} from '../src/lib/n2oSaturation.js'

let checks = 0
function close(actual, expected, tol, what) {
  checks++
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} +/- ${tol}`,
  )
}
function ok(cond, what) {
  checks++
  assert.ok(cond, what)
}

// ── 1. Table integrity ───────────────────────────────────────────────────────
// Both lookups binary-search, so a non-monotonic column would not throw - it
// would quietly return a wrong answer. Check it explicitly.
const curve = saturationCurve(N2O_TRIPLE_C, N2O_CRITICAL_C)
ok(curve.length > 100, `curve has ${curve.length} points`)
for (let i = 1; i < curve.length; i++) {
  ok(curve[i][0] > curve[i - 1][0], `T ascending at ${i} (${curve[i - 1][0]} -> ${curve[i][0]})`)
  ok(curve[i][1] > curve[i - 1][1], `P ascending at ${i} (${curve[i - 1][1]} -> ${curve[i][1]})`)
}

// ── 2. Endpoints are the real triple and critical points ─────────────────────
close(curve[0][0], N2O_TRIPLE_C, 1e-9, 'first row is the triple point (T)')
close(curve[0][1], N2O_TRIPLE_PSIA, 1e-6, 'first row is the triple point (P)')
close(curve.at(-1)[0], N2O_CRITICAL_C, 1e-9, 'last row is the critical point (T)')
close(curve.at(-1)[1], N2O_CRITICAL_PSIA, 1e-6, 'last row is the critical point (P)')

// NIST values, restated independently of the table so a bad regeneration is
// caught rather than blessed.
close(N2O_TRIPLE_C, -90.82, 0.01, 'triple point temperature')
close(N2O_CRITICAL_C, 36.37, 0.01, 'critical point temperature')
close(N2O_CRITICAL_PSIA, 1050.8, 0.1, 'critical point pressure')

// ── 3. Domain guards ─────────────────────────────────────────────────────────
// Out of range must be null, never a clamped or extrapolated number: the card
// renders an em dash for null, and a plausible-looking wrong number is worse
// than a blank on a pad display.
ok(pSatFromT(N2O_TRIPLE_C - 0.01) === null, 'pSatFromT below triple -> null')
ok(pSatFromT(N2O_CRITICAL_C + 0.01) === null, 'pSatFromT above critical -> null')
ok(tSatFromP(N2O_TRIPLE_PSIA - 0.01) === null, 'tSatFromP below triple -> null')
ok(tSatFromP(N2O_CRITICAL_PSIA + 0.01) === null, 'tSatFromP above critical -> null')
ok(pSatFromT(NaN) === null, 'pSatFromT(NaN) -> null')
ok(pSatFromT(undefined) === null, 'pSatFromT(undefined) -> null')
ok(tSatFromP(NaN) === null, 'tSatFromP(NaN) -> null')
ok(tSatFromP(null) === null, 'tSatFromP(null) -> null')
ok(pSatFromT(N2O_TRIPLE_C) !== null, 'triple point itself is in range')
ok(tSatFromP(N2O_CRITICAL_PSIA) !== null, 'critical point itself is in range')

// ── 4. Inversion ─────────────────────────────────────────────────────────────
// Passes to machine precision by construction - the two functions share one
// interpolant. This tests the algebra and the bracketing, NOT the accuracy.
// Accuracy is section 5.
for (let t = -90; t <= 36; t += 0.37) {
  close(tSatFromP(pSatFromT(t)), t, 1e-9, `round trip at ${t.toFixed(2)} C`)
}

// ── 5. Accuracy against NIST rows the table does not contain ─────────────────
// The baked table keeps every 5th row of a 601-row NIST fetch. These are five of
// the dropped rows, spread across the operating range - genuine ground truth,
// unlike the round trip above.
const NIST_SPOT_CHECKS = [
  [-35.067, 161.53],
  [-9.1532, 355.30],
  [7.9697, 552.53],
  [20.806, 746.30],
  [31.336, 941.80],
]
for (const [t, p] of NIST_SPOT_CHECKS) {
  close(pSatFromT(t), p, 0.25, `pSatFromT(${t}) vs NIST`)
  close(tSatFromP(p), t, 0.02, `tSatFromP(${p}) vs NIST`)
}

// ── 6. The gauge/absolute seam ───────────────────────────────────────────────
// N2O resting at 20 C sits at 732.8 psia per NIST, i.e. 718.1 psig. The two
// numbers differ by one atmosphere, which is the entire point of this check: if
// the conversion is ever dropped, T_sat for a 718 psig tank reads ~19.3 C
// instead of 20 C - wrong by little enough to look plausible on the card.
const restingPsia = pSatFromT(20)
close(restingPsia, 732.8, 1, 'N2O at 20 C sits near 732.8 psia (NIST)')
const restingPsig = psigOf(restingPsia)
close(restingPsig, 718.1, 1, 'the same point in gauge terms')
close(tSatFromP(restingPsig), 19.3, 0.2, 'feeding gauge psi in as absolute is wrong by ~0.7 C')

// The card displays gauge and the table is absolute, so these two run on every
// value the operator sees. They must be exact inverses and must not turn an
// absent reading into a number.
close(psigOf(restingPsia), restingPsia - PSI_PER_ATM, 1e-12, 'psigOf subtracts one atmosphere')
close(psiaOf(restingPsig), restingPsia, 1e-9, 'psiaOf is its inverse')
close(psiaOf(psigOf(1000)), 1000, 1e-9, 'gauge round trip')
ok(psigOf(null) === null, 'psigOf(null) stays null, not -14.696')
ok(psiaOf(null) === null, 'psiaOf(null) stays null')
ok(psigOf(undefined) === null, 'psigOf(undefined) stays null')
ok(psiaOf(undefined) === null, 'psiaOf(undefined) stays null')

// A tank at 0 psig is at one atmosphere absolute - the vented case the card has
// to render without inventing anything.
close(psiaOf(0), PSI_PER_ATM, 1e-12, '0 psig is one atmosphere absolute')
ok(tSatFromP(psiaOf(0)) !== null, 'a vented tank still has a saturation temperature')
close(tSatFromP(restingPsig + PSI_PER_ATM), 20, 0.01, 'gauge -> absolute -> T_sat round trip')

// ── 7. Curve windowing ───────────────────────────────────────────────────────
// The chart asks for a window; the edges must land on the window, not on the
// nearest table row, or the drawn line stops short of the frame.
const win = saturationCurve(-40, 40)
close(win[0][0], -40, 1e-9, 'window clipped to tMin exactly')
close(win.at(-1)[0], N2O_CRITICAL_C, 1e-9, 'window clamped to critical, not 40 C')
close(win[0][1], pSatFromT(-40), 1e-9, 'window start pressure is consistent')
ok(saturationCurve(50, 60).length === 0, 'window entirely above critical -> empty')

console.log(`n2oSaturation: ${checks} checks passed`)
