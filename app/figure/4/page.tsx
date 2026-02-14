"use client";

import React, { useMemo, useState } from "react";

/** =========================
 *  Types
 *  ========================= */
type Rect = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type LineFamily = { value: number; pts: Pt[] }; // PH: value=ft, SLOPE/WIND: value=id (negative = left side, positive = right side)

type Inputs = {
  pressureHeightFt: number;
  shadeTempC: number;

  // Conventions:
  //  slopePercent: + = UP, - = DOWN
  //  windComponentKt: + = HEAD, - = TAIL
  slopePercent: number;
  windComponentKt: number;

  landingWeightKg: number; // climb-limit check only
};

/** =========================
 *  Small utilities
 *  ========================= */
function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}
function roundWhole(v: number) {
  return Math.round(v);
}
function mapLin(v: number, v0: number, v1: number, p0: number, p1: number) {
  if (Math.abs(v1 - v0) < 1e-9) return p0;
  const t = (v - v0) / (v1 - v0);
  return p0 + t * (p1 - p0);
}
function buildPathD(points: Pt[]) {
  if (!points.length) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
}
/** =========================
 *  Robust intersection (vertical X)
 *  ========================= */
type IntersectOpts = {
  extrapolate?: boolean;
  extrapolateLimitPx?: number;
};

function quadraticExtrapolateEnd(
  pts: Pt[],
  X: number,
  side: "left" | "right"
): number | null {
  if (pts.length < 3) return null;

  const asc = pts[0].x <= pts[pts.length - 1].x;
  const p = asc ? pts : [...pts].reverse();

  const n = p.length;
  const p0 = side === "left" ? p[0] : p[n - 3];
  const p1 = side === "left" ? p[1] : p[n - 2];
  const p2 = side === "left" ? p[2] : p[n - 1];

  const x0 = p0.x,
    x1 = p1.x,
    x2 = p2.x;
  const y0 = p0.y,
    y1 = p1.y,
    y2 = p2.y;

  const d0 = (x0 - x1) * (x0 - x2);
  const d1 = (x1 - x0) * (x1 - x2);
  const d2 = (x2 - x0) * (x2 - x1);

  const EPS = 1e-6;
  if (Math.abs(d0) < EPS || Math.abs(d1) < EPS || Math.abs(d2) < EPS) return null;

  const y =
    (y0 * (X - x1) * (X - x2)) / d0 +
    (y1 * (X - x0) * (X - x2)) / d1 +
    (y2 * (X - x0) * (X - x1)) / d2;

  if (!Number.isFinite(y)) return null;
  if (Math.abs(y) > 1e7) return null;
  return y;
}

function intersectPolylineWithVerticalX(
  pts: Pt[],
  X: number,
  preferNearY?: number,
  opts?: IntersectOpts
): number | null {
  const hits: number[] = [];
  const EPS = 1e-6;

  if (pts.length < 2) return null;

  const extrapolate = opts?.extrapolate ?? false;
  const limit = opts?.extrapolateLimitPx ?? 220;

  let minXAll = Infinity;
  let maxXAll = -Infinity;
  for (const p of pts) {
    if (p.x < minXAll) minXAll = p.x;
    if (p.x > maxXAll) maxXAll = p.x;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;

    if (Math.abs(dx) < EPS) {
      if (Math.abs(X - a.x) < 0.75) hits.push((a.y + b.y) / 2);
      continue;
    }

    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    if (X < minX - EPS || X > maxX + EPS) continue;

    const t = (X - a.x) / dx;
    if (t < -EPS || t > 1 + EPS) continue;

    hits.push(a.y + t * (b.y - a.y));
  }

  if (hits.length) {
    if (hits.length === 1) return hits[0];

    const targetY = preferNearY ?? hits.reduce((s, y) => s + y, 0) / hits.length;
    hits.sort((y1, y2) => Math.abs(y1 - targetY) - Math.abs(y2 - targetY));
    return hits[0];
  }

  if (!extrapolate) return null;

  // only allow small extrapolation distance in px
  if (X < minXAll - limit || X > maxXAll + limit) return null;

  if (X < minXAll - EPS) {
    const q = quadraticExtrapolateEnd(pts, X, "left");
    if (q != null) return q;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      if (Math.abs(dx) < EPS) continue;
      const t = (X - a.x) / dx;
      return a.y + t * (b.y - a.y);
    }
    return null;
  }

  if (X > maxXAll + EPS) {
    const q = quadraticExtrapolateEnd(pts, X, "right");
    if (q != null) return q;
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      if (Math.abs(dx) < EPS) continue;
      const t = (X - a.x) / dx;
      return a.y + t * (b.y - a.y);
    }
    return null;
  }

  return null;
}

/** =========================
 *  One-sided (value-space) solver for slope & wind
 *  ========================= */
type ParamPt = { u: number; y: number };
type OneSide = "neg" | "pos";

type ExtrapolateMode = "linear" | "quadraticNearLinearFar";

function dedupeParamByUSorted(pts: ParamPt[], eps = 1e-4) {
  const out: ParamPt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    if (Math.abs(p.u - last.u) < eps) {
      out[out.length - 1] = { u: (p.u + last.u) / 2, y: (p.y + last.y) / 2 };
    } else {
      out.push(p);
    }
  }
  return out;
}

function yAtU1D(
  ptsSorted: ParamPt[],
  U: number,
  mode: ExtrapolateMode = "quadraticNearLinearFar"
): number | null {
  if (!ptsSorted.length) return null;
  if (ptsSorted.length === 1) return ptsSorted[0].y;

  // in-range interpolation
  for (let i = 0; i < ptsSorted.length - 1; i++) {
    const a = ptsSorted[i];
    const b = ptsSorted[i + 1];
    if (a.u <= U && U <= b.u) {
      const du = b.u - a.u;
      if (Math.abs(du) < 1e-9) return a.y;
      const t = (U - a.u) / du;
      return a.y + t * (b.y - a.y);
    }
  }

  const leftEnd = ptsSorted[0];
  const rightEnd = ptsSorted[ptsSorted.length - 1];

  const linearFrom = (a: ParamPt, b: ParamPt) => {
    const du = b.u - a.u;
    if (Math.abs(du) < 1e-9) return a.y;
    const t = (U - a.u) / du;
    return a.y + t * (b.y - a.y);
  };

  const quadraticMaybe = (side: "left" | "right") => {
    if (ptsSorted.length < 3) return null;

    const p0 = side === "left" ? ptsSorted[0] : ptsSorted[ptsSorted.length - 3];
    const p1 = side === "left" ? ptsSorted[1] : ptsSorted[ptsSorted.length - 2];
    const p2 = side === "left" ? ptsSorted[2] : ptsSorted[ptsSorted.length - 1];

    const u0 = p0.u,
      u1 = p1.u,
      u2 = p2.u;
    const y0 = p0.y,
      y1 = p1.y,
      y2 = p2.y;

    const d0 = (u0 - u1) * (u0 - u2);
    const d1 = (u1 - u0) * (u1 - u2);
    const d2 = (u2 - u0) * (u2 - u1);

    const EPS = 1e-9;
    if (Math.abs(d0) < EPS || Math.abs(d1) < EPS || Math.abs(d2) < EPS) return null;

    const y =
      (y0 * (U - u1) * (U - u2)) / d0 +
      (y1 * (U - u0) * (U - u2)) / d1 +
      (y2 * (U - u0) * (U - u1)) / d2;

    if (!Number.isFinite(y)) return null;
    if (Math.abs(y) > 1e7) return null;
    return y;
  };

  // left extrapolation
  if (U < leftEnd.u) {
    if (mode === "linear") return linearFrom(ptsSorted[0], ptsSorted[1]);

    const span =
      Math.abs(ptsSorted[2]?.u - ptsSorted[0].u) ||
      Math.abs(ptsSorted[1].u - ptsSorted[0].u);
    const dist = Math.abs(U - leftEnd.u);

    if (ptsSorted.length >= 3 && dist <= 3 * span) {
      const q = quadraticMaybe("left");
      if (q != null) return q;
    }
    return linearFrom(ptsSorted[0], ptsSorted[1]);
  }

  // right extrapolation
  if (U > rightEnd.u) {
    if (mode === "linear")
      return linearFrom(
        ptsSorted[ptsSorted.length - 2],
        ptsSorted[ptsSorted.length - 1]
      );

    const span =
      Math.abs(rightEnd.u - ptsSorted[ptsSorted.length - 3]?.u) ||
      Math.abs(rightEnd.u - ptsSorted[ptsSorted.length - 2].u);
    const dist = Math.abs(U - rightEnd.u);

    if (ptsSorted.length >= 3 && dist <= 3 * span) {
      const q = quadraticMaybe("right");
      if (q != null) return q;
    }
    return linearFrom(
      ptsSorted[ptsSorted.length - 2],
      ptsSorted[ptsSorted.length - 1]
    );
  }

  return null;
}

type PreparedOneSided = {
  y0: number; // y at ref line
  side: OneSide;
  pts: ParamPt[]; // sorted by u (includes anchor u=0)
  extrapolateMode: ExtrapolateMode;
};

type BuildOneSidedOpts = {
  anchorExtrapolatePx?: number;
  dedupeUEps?: number;
  extrapolateMode?: ExtrapolateMode;
};

function buildOneSidedCurveFromPx(
  pxPts: Pt[],
  refX: number,
  xToU: (x: number) => number,
  side: OneSide,
  opts?: BuildOneSidedOpts
): PreparedOneSided | null {
  if (pxPts.length < 2) return null;

  const anchorExtrapolatePx = opts?.anchorExtrapolatePx ?? 220;
  const dedupeUEps = opts?.dedupeUEps ?? 1e-4;
  const extrapolateMode = opts?.extrapolateMode ?? "quadraticNearLinearFar";

  const y0 =
    intersectPolylineWithVerticalX(pxPts, refX, undefined, {
      extrapolate: true,
      extrapolateLimitPx: anchorExtrapolatePx,
    }) ?? null;
  if (y0 == null) return null;

  const EPS_SIDE = 1e-6;

  let all: ParamPt[] = pxPts
    .map((p) => ({ u: xToU(p.x), y: p.y }))
    .filter((p) => Number.isFinite(p.u) && Number.isFinite(p.y));

  // Keep only the side we care about (this is the whole point of the fix)
  if (side === "neg") all = all.filter((p) => p.u <= 0 + EPS_SIDE);
  else all = all.filter((p) => p.u >= 0 - EPS_SIDE);

  // Add hard anchor at u=0
  all.push({ u: 0, y: y0 });

  all.sort((a, b) => a.u - b.u);
  const dedup = dedupeParamByUSorted(all, dedupeUEps);

  // Need at least two distinct u values to define a gradient/curve
  if (dedup.length < 2) return null;
  const minU = dedup[0].u;
  const maxU = dedup[dedup.length - 1].u;
  if (Math.abs(maxU - minU) < 1e-6) return null;

  return { y0, side, pts: dedup, extrapolateMode };
}

function prepareOneSidedFamily(
  familyPx: LineFamily[],
  refX: number,
  xToU: (x: number) => number,
  side: OneSide,
  opts?: BuildOneSidedOpts
): PreparedOneSided[] {
  const out: PreparedOneSided[] = [];
  for (const ln of familyPx) {
    const c = buildOneSidedCurveFromPx(ln.pts, refX, xToU, side, opts);
    if (!c) continue;
    out.push(c);
  }
  // sort by y0 (this is the correct ordering for bracketing/interpolation)
  out.sort((a, b) => a.y0 - b.y0);
  return out;
}

function followOneSidedFamily(
  prepared: PreparedOneSided[],
  uToX: (u: number) => number,
  startYAtRef: number,
  targetU: number,
  samples = 28
): { y: number; pts: Pt[] } | null {
  if (!prepared.length) return null;

  const EPS = 1e-9;
  if (Math.abs(targetU) < EPS) {
    const x0 = uToX(0);
    return { y: startYAtRef, pts: [{ x: x0, y: startYAtRef }, { x: x0, y: startYAtRef }] };
  }

  // Clamp startY outside family range
  if (startYAtRef <= prepared[0].y0) {
    const c = prepared[0];
    const yT = yAtU1D(c.pts, targetU, c.extrapolateMode);
    if (yT == null) return null;
    const pts: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const ui = mapLin(i, 0, samples, 0, targetU);
      const yi = yAtU1D(c.pts, ui, c.extrapolateMode);
      if (yi == null) continue;
      pts.push({ x: uToX(ui), y: yi });
    }
    if (!pts.length) return { y: yT, pts: [{ x: uToX(0), y: startYAtRef }, { x: uToX(targetU), y: yT }] };
    pts[0] = { x: uToX(0), y: startYAtRef };
    pts[pts.length - 1] = { x: uToX(targetU), y: yT };
    return { y: yT, pts };
  }

  if (startYAtRef >= prepared[prepared.length - 1].y0) {
    const c = prepared[prepared.length - 1];
    const yT = yAtU1D(c.pts, targetU, c.extrapolateMode);
    if (yT == null) return null;
    const pts: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const ui = mapLin(i, 0, samples, 0, targetU);
      const yi = yAtU1D(c.pts, ui, c.extrapolateMode);
      if (yi == null) continue;
      pts.push({ x: uToX(ui), y: yi });
    }
    if (!pts.length) return { y: yT, pts: [{ x: uToX(0), y: startYAtRef }, { x: uToX(targetU), y: yT }] };
    pts[0] = { x: uToX(0), y: startYAtRef };
    pts[pts.length - 1] = { x: uToX(targetU), y: yT };
    return { y: yT, pts };
  }

  // Bracket startY by y0
  let lo = prepared[0];
  let hi = prepared[prepared.length - 1];
  for (let i = 0; i < prepared.length - 1; i++) {
    if (prepared[i].y0 <= startYAtRef && startYAtRef <= prepared[i + 1].y0) {
      lo = prepared[i];
      hi = prepared[i + 1];
      break;
    }
  }

  const denom = hi.y0 - lo.y0;
  const t = Math.abs(denom) < 1e-9 ? 0 : (startYAtRef - lo.y0) / denom;

  const yLoT = yAtU1D(lo.pts, targetU, lo.extrapolateMode);
  const yHiT = yAtU1D(hi.pts, targetU, hi.extrapolateMode);
  if (yLoT == null || yHiT == null) return null;

  const yTarget = yLoT + t * (yHiT - yLoT);

  // Blend trace in y-space, x from uToX
  const pts: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const ui = mapLin(i, 0, samples, 0, targetU);

    const yLo = yAtU1D(lo.pts, ui, lo.extrapolateMode);
    const yHi = yAtU1D(hi.pts, ui, hi.extrapolateMode);
    if (yLo == null || yHi == null) continue;

    const yi = yLo + t * (yHi - yLo);
    pts.push({ x: uToX(ui), y: yi });
  }

  if (!pts.length) return { y: yTarget, pts: [{ x: uToX(0), y: startYAtRef }, { x: uToX(targetU), y: yTarget }] };
  pts[0] = { x: uToX(0), y: startYAtRef };
  pts[pts.length - 1] = { x: uToX(targetU), y: yTarget };

  return { y: yTarget, pts };
}

/** =========================
 *  Family solving (PH step)
 *  ========================= */
function solveFamilyYAtX(
  family: LineFamily[],
  X: number,
  v: number,
  preferNearY?: number
): number | null {
  if (!family.length) return null;

  const sorted = [...family].sort((a, b) => a.value - b.value);
  const vClamped = clamp(v, sorted[0].value, sorted[sorted.length - 1].value);

  const exact = sorted.find((l) => Math.abs(l.value - vClamped) < 1e-9);
  if (exact) return intersectPolylineWithVerticalX(exact.pts, X, preferNearY);

  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];

  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].value <= vClamped && vClamped <= sorted[i + 1].value) {
      lo = sorted[i];
      hi = sorted[i + 1];
      break;
    }
  }

  const yLo = intersectPolylineWithVerticalX(lo.pts, X, preferNearY);
  const yHi = intersectPolylineWithVerticalX(hi.pts, X, preferNearY);
  if (yLo == null || yHi == null) return null;

  const t = (vClamped - lo.value) / (hi.value - lo.value);
  return yLo + t * (yHi - yLo);
}

/** =========================
 *  Figure 4 config
 *  ========================= */
const FIG4 = {
  viewBox: { w: 1024, h: 723 },

  panels: {
    frame: { x: 52, y: 50, w: 922, h: 622 } satisfies Rect,

    climbMini: { x: 75, y: 107, w: 225, h: 206 } satisfies Rect,
    climbYAxis: { x: 118, y: 109, w: 14, h: 130 } satisfies Rect,

    phTempNomogram: { x: 60, y: 329, w: 263, h: 261 } satisfies Rect,

    mainGrid: { x: 323, y: 240, w: 437, h: 350 } satisfies Rect,
    slopeGrid: { x: 367, y: 240, w: 175, h: 350 } satisfies Rect,
    windGrid: { x: 607, y: 240, w: 110, h: 350 } satisfies Rect,
  },

  refs: {
    slopeRefX: 410.5,
    windRefX: 629,
  },

  ranges: {
    shadeTempC: { lo: -10, hi: 50 },
    pressureHeightFt: { lo: 0, hi: 6000 },

    distanceM: { lo: 200, hi: 1000 },

    slopePct: { lo: -2, hi: 6 },
    windKt: { lo: -5, hi: 20 },
  },

  climbAxisTicks: {
    yAt1000: 121.7,
    yAt1050: 229,
  },

  climbLimits: {
    maxKg: 1055,
  },
} as const;

/** =========================
 *  Digitised curve data
 *  ========================= */
const PH_LINES: LineFamily[] = [
  {
    value: 0,
    pts: [
      { x: 124.53200234879627, y: 444.35701702877276 },
      { x: 298.8784497944804, y: 410.3934233705226 },
    ],
  },
  {
    value: 2000,
    pts: [
      { x: 109.81444509688787, y: 430.77157956547273 },
      { x: 281.8966529653553, y: 392.2795067527892 },
    ],
  },
  {
    value: 4000,
    pts: [
      { x: 92.83264826776279, y: 414.92190252495595 },
      { x: 261.5184967704052, y: 373.0334703464474 },
    ],
  },
  {
    value: 6000,
    pts: [
      { x: 74.71873165002937, y: 399.07222548443923 },
      { x: 245.66881972988847, y: 357.18379330593075 },
    ],
  },
];

// Digitised slope curves (-7..-1, 1..7)
const SLOPE_CURVES: LineFamily[] = [
  {
    value: -7,
    pts: [
      { x: 410.06643660928427, y: 325.36960818193864 },
      { x: 367.9328774746766, y: 276.37361296259076 },
    ],
  },
  {
    value: -6,
    pts: [
      { x: 410.06643660928427, y: 348.1513203925317 },
      { x: 367.9328774746766, y: 302.8349256380458 },
    ],
  },
  {
    value: -5,
    pts: [
      { x: 410.77498719401547, y: 371.71830491779207 },
      { x: 367.9328774746766, y: 328.0361666494215 },
    ],
  },
  {
    value: -4,
    pts: [
      { x: 410.06643660928427, y: 393.7147565125139 },
      { x: 367.9328774746766, y: 353.2374076607972 },
    ],
  },
  {
    value: -3,
    pts: [
      { x: 410.77498719401547, y: 412.46031442401966 },
      { x: 367.9328774746766, y: 380.9587631598 },
    ],
  },
  {
    value: -2,
    pts: [
      { x: 410.06643660928427, y: 438.4019578265004 },
      { x: 367.9328774746766, y: 398.5996414812736 },
    ],
  },
  {
    value: -1,
    pts: [
      { x: 408.31399707991125, y: 457.09464836815505 },
      { x: 367.9328774746766, y: 426.3210065937868 },
    ],
  },
  {
    value: 1,
    pts: [
      { x: 410.06643660928427, y: 457.09464836815505 },
      { x: 494.67786014216153, y: 478.85617244942034 },
      { x: 539.6486994918453, y: 488.84969230490566 },
    ],
  },
  {
    value: 2,
    pts: [
      { x: 410.06643660928427, y: 436.065387385731 },
      { x: 487.17377590169855, y: 457.0946617382076 },
      { x: 541.4994013122632, y: 469.0696562755551 },
    ],
  },
  {
    value: 3,
    pts: [
      { x: 410.06643660928427, y: 414.1598798985153 },
      { x: 495.9359735485638, y: 438.694033309738 },
      { x: 539.7469617828901, y: 447.4562309566033 },
    ],
  },
  {
    value: 4,
    pts: [
      { x: 411.81887613865734, y: 395.46719604188695 },
      { x: 495.9359735485638, y: 420.0013494531097 },
      { x: 539.7469617828901, y: 432.268426158721 },
    ],
  },
  {
    value: 5,
    pts: [
      { x: 497.6884130779368, y: 400.1403636635309 },
      { x: 541.4994013122632, y: 412.40744036914225 },
    ],
  },
  {
    value: 6,
    pts: [
      { x: 410.06643660928427, y: 347.56717778233934 },
      { x: 497.6884130779368, y: 379.1110893110543 },
      { x: 541.4994013122632, y: 394.8830450754117 },
    ],
  },
  {
    value: 7,
    pts: [
      { x: 497.6884130779368, y: 360.41840545442597 },
      { x: 541.4994013122632, y: 370.9330426306642 },
    ],
  },
];
// Digitised wind curves (-6..-1, 1..6)
const WIND_CURVES: LineFamily[] = [
  {
    value: -6,
    pts: [
      { x: 628.7657219424154, y: 283.513961377977 },
      { x: 607.3446670827461, y: 244.45203781034462 },
    ],
  },
  {
    value: -5,
    pts: [
      { x: 628.7657219424154, y: 326.35607109731575 },
      { x: 607.3446670827461, y: 275.95358907456426 },
    ],
  },
  {
    value: -4,
    pts: [
      { x: 628.7657219424154, y: 370.4582428672233 },
      { x: 607.3446670827461, y: 321.3158228950406 },
    ],
  },
  {
    value: -3,
    pts: [
      { x: 627.5056598918468, y: 414.5604146371308 },
      { x: 607.3446670827461, y: 371.71830491779207 },
    ],
  },
  {
    value: -2,
    pts: [
      { x: 628.7657219424154, y: 457.40252435646954 },
      { x: 607.3446670827461, y: 422.1207869405435 },
    ],
  },
  {
    value: -1,
    pts: [
      { x: 627.5056598918468, y: 501.5046961263771 },
      { x: 607.3446670827461, y: 464.9628966598823 },
    ],
  },
  {
    value: 1,
    pts: [
      { x: 630.0257839929843, y: 504.02482022751474 },
      { x: 716.9700654822307, y: 548.1269919974222 },
    ],
  },
  {
    value: 2,
    pts: [
      { x: 630.0257839929843, y: 458.66258640703836 },
      { x: 715.7100034316618, y: 514.105316632065 },
    ],
  },
  {
    value: 3,
    pts: [
      { x: 628.7657219424154, y: 414.56041463713086 },
      { x: 715.7100034316618, y: 470.00314486215746 },
    ],
  },
  {
    value: 4,
    pts: [
      { x: 630.0257839929843, y: 371.71830491779207 },
      { x: 715.7100034316618, y: 432.2012833450938 },
    ],
  },
  {
    value: 5,
    pts: [
      { x: 630.0257839929843, y: 328.87619519845333 },
      { x: 715.7100034316618, y: 396.91954592916784 },
    ],
  },
  {
    value: 6,
    pts: [
      { x: 628.7657219424154, y: 284.7740234285458 },
      { x: 714.4499413810929, y: 343.99693980527877 },
    ],
  },
];

/** =========================
 *  Mapping helpers
 *  ========================= */
function tempToX(c: number) {
  const r = FIG4.ranges.shadeTempC;
  const g = FIG4.panels.phTempNomogram;
  return mapLin(c, r.lo, r.hi, g.x, g.x + g.w);
}

function yToDistanceM(y: number) {
  const r = FIG4.ranges.distanceM;
  const g = FIG4.panels.mainGrid;
  return mapLin(y, g.y + g.h, g.y, r.lo, r.hi);
}

function yToClimbLimitKgRaw(y: number) {
  const { yAt1000, yAt1050 } = FIG4.climbAxisTicks;
  return mapLin(y, yAt1000, yAt1050, 1000, 1050);
}
function kgToClimbY(kg: number) {
  const { yAt1000, yAt1050 } = FIG4.climbAxisTicks;
  return mapLin(kg, 1000, 1050, yAt1000, yAt1050);
}

/**
 * Piecewise axis mapping around reference line:
 * - slope: left side is DOWN (-2..0), right side is UP (0..6)
 * - wind : left side is TAIL (-5..0), right side is HEAD (0..20)
 */
function slopeToX(pct: number) {
  const r = FIG4.ranges.slopePct;
  const g = FIG4.panels.slopeGrid;
  const refX = FIG4.refs.slopeRefX;

  if (pct <= 0) return mapLin(pct, r.lo, 0, g.x, refX);
  return mapLin(pct, 0, r.hi, refX, g.x + g.w);
}
function windToX(kt: number) {
  const r = FIG4.ranges.windKt;
  const g = FIG4.panels.windGrid;
  const refX = FIG4.refs.windRefX;

  if (kt <= 0) return mapLin(kt, r.lo, 0, g.x, refX);
  return mapLin(kt, 0, r.hi, refX, g.x + g.w);
}
function xToSlopePct(x: number) {
  const r = FIG4.ranges.slopePct;
  const g = FIG4.panels.slopeGrid;
  const refX = FIG4.refs.slopeRefX;

  if (x <= refX) return mapLin(x, g.x, refX, r.lo, 0);
  return mapLin(x, refX, g.x + g.w, 0, r.hi);
}
function xToWindKt(x: number) {
  const r = FIG4.ranges.windKt;
  const g = FIG4.panels.windGrid;
  const refX = FIG4.refs.windRefX;

  if (x <= refX) return mapLin(x, g.x, refX, r.lo, 0);
  return mapLin(x, refX, g.x + g.w, 0, r.hi);
}

function splitFamiliesBySign(family: LineFamily[]) {
  return {
    neg: family.filter((l) => l.value < 0),
    pos: family.filter((l) => l.value > 0),
  };
}

/** =========================
 *  Component
 *  ========================= */
export default function Figure4Page() {
  const [inputs, setInputs] = useState<Inputs>({
    pressureHeightFt: 2000,
    shadeTempC: 20,
    slopePercent: +2,
    windComponentKt: +10,
    landingWeightKg: 1000,
  });

  const effective = useMemo(() => {
    return {
      pressureHeightFt: roundWhole(clamp(inputs.pressureHeightFt, 0, 6000)),
      shadeTempC: roundWhole(clamp(inputs.shadeTempC, -10, 50)),
      slopePercent: roundWhole(clamp(inputs.slopePercent, -2, 6)),
      windComponentKt: roundWhole(clamp(inputs.windComponentKt, -5, 20)),
      landingWeightKg: roundWhole(clamp(inputs.landingWeightKg, 800, 1200)),
    } satisfies Inputs;
  }, [inputs]);

  const { w: VIEWBOX_W, h: VIEWBOX_H } = FIG4.viewBox;
  const { panels, refs } = FIG4;

  const REFERENCE_IMAGE_SRC = "/charts/workbook_v3_0a/figure_4.png";
  const SHOW_REFERENCE_IMAGE = true;
  const activePhLines = PH_LINES;
  const activeSlopeCurves = SLOPE_CURVES;
  const activeWindCurves = WIND_CURVES;

  /** ===== Step 1: PH solve ===== */
  const tempX = tempToX(effective.shadeTempC);
  const preferY = panels.phTempNomogram.y + panels.phTempNomogram.h * 0.55;

  const phSolvedY =
    solveFamilyYAtX(activePhLines, tempX, effective.pressureHeightFt, preferY) ??
    mapLin(
      effective.pressureHeightFt,
      FIG4.ranges.pressureHeightFt.lo,
      FIG4.ranges.pressureHeightFt.hi,
      panels.phTempNomogram.y + panels.phTempNomogram.h,
      panels.phTempNomogram.y
    );

  const startPt: Pt = { x: tempX, y: panels.phTempNomogram.y + panels.phTempNomogram.h };
  const phHitPt: Pt = { x: tempX, y: phSolvedY };
  const toSlopeRefPt: Pt = { x: refs.slopeRefX, y: phHitPt.y };
  const phMainTrace: Pt[] = [startPt, phHitPt, toSlopeRefPt];

  /** ===== Climb split (PH >= 4000) ===== */
  const needsClimbCheck = effective.pressureHeightFt >= 4000;
  const branchX = clamp(
    tempX,
    panels.climbMini.x + 2,
    panels.climbMini.x + panels.climbMini.w - 2
  );

  // Placeholder climb curve
  const climbY = mapLin(
    effective.pressureHeightFt,
    4000,
    6000,
    panels.climbMini.y + panels.climbMini.h - 10,
    panels.climbMini.y + 10
  );

  const climbBranch: Pt[] = needsClimbCheck
    ? [phHitPt, { x: branchX, y: phHitPt.y }, { x: branchX, y: climbY }]
    : [];

  const climbAxisX = panels.climbYAxis.x + panels.climbYAxis.w / 2;
  const climbReadLine: Pt[] = needsClimbCheck
    ? [{ x: branchX, y: climbY }, { x: climbAxisX, y: climbY }]
    : [];

  const climbKgRaw = needsClimbCheck ? yToClimbLimitKgRaw(climbY) : null;
  const climbIsMax = climbKgRaw != null && climbKgRaw >= FIG4.climbLimits.maxKg - 0.25;

  const climbLimitForCheck =
    climbKgRaw == null ? null : climbIsMax ? FIG4.climbLimits.maxKg : Math.round(climbKgRaw);

  const climbExceeded =
    climbLimitForCheck != null && effective.landingWeightKg > climbLimitForCheck;

  const climbLabel = climbKgRaw == null ? "" : climbIsMax ? "MAX" : `${Math.round(climbKgRaw)} kg`;

  /** ===== Step 2: Slope follow (NEG uses ONLY negative-ID curves; POS uses ONLY positive-ID curves) ===== */
  const { neg: slopeNegLines, pos: slopePosLines } = useMemo(
    () => splitFamiliesBySign(activeSlopeCurves),
    [activeSlopeCurves]
  );

  const preparedSlopeNeg = useMemo(() => {
    return prepareOneSidedFamily(slopeNegLines, refs.slopeRefX, xToSlopePct, "neg", {
      anchorExtrapolatePx: 220,
      extrapolateMode: "quadraticNearLinearFar",
      dedupeUEps: 1e-4,
    });
  }, [slopeNegLines, refs.slopeRefX]);

  const preparedSlopePos = useMemo(() => {
    return prepareOneSidedFamily(slopePosLines, refs.slopeRefX, xToSlopePct, "pos", {
      anchorExtrapolatePx: 220,
      extrapolateMode: "quadraticNearLinearFar",
      dedupeUEps: 1e-4,
    });
  }, [slopePosLines, refs.slopeRefX]);

  const slopeFollow = useMemo(() => {
    const u = effective.slopePercent;
    if (u < 0) return followOneSidedFamily(preparedSlopeNeg, slopeToX, phHitPt.y, u, 34);
    if (u > 0) return followOneSidedFamily(preparedSlopePos, slopeToX, phHitPt.y, u, 34);
    return followOneSidedFamily(preparedSlopePos, slopeToX, phHitPt.y, 0, 2); // trivial
  }, [effective.slopePercent, preparedSlopeNeg, preparedSlopePos, phHitPt.y]);

  const yAfterSlope = slopeFollow?.y ?? phHitPt.y;
  const toWindRefAfterSlope: Pt = { x: refs.windRefX, y: yAfterSlope };

  const slopeTracePts: Pt[] = slopeFollow
    ? [...slopeFollow.pts, toWindRefAfterSlope]
    : [
        toSlopeRefPt,
        { x: slopeToX(effective.slopePercent), y: phHitPt.y },
        toWindRefAfterSlope,
      ];

  /** ===== Step 3: Wind follow (NEG uses ONLY negative-ID curves; POS uses ONLY positive-ID curves) ===== */
  const { neg: windNegLines, pos: windPosLines } = useMemo(
    () => splitFamiliesBySign(activeWindCurves),
    [activeWindCurves]
  );

  const preparedWindNeg = useMemo(() => {
    return prepareOneSidedFamily(windNegLines, refs.windRefX, xToWindKt, "neg", {
      anchorExtrapolatePx: 220,
      extrapolateMode: "quadraticNearLinearFar",
      dedupeUEps: 1e-4,
    });
  }, [windNegLines, refs.windRefX]);

  const preparedWindPos = useMemo(() => {
    return prepareOneSidedFamily(windPosLines, refs.windRefX, xToWindKt, "pos", {
      anchorExtrapolatePx: 220,
      extrapolateMode: "quadraticNearLinearFar",
      dedupeUEps: 1e-4,
    });
  }, [windPosLines, refs.windRefX]);

  const windFollow = useMemo(() => {
    const u = effective.windComponentKt;
    if (u < 0) return followOneSidedFamily(preparedWindNeg, windToX, yAfterSlope, u, 28);
    if (u > 0) return followOneSidedFamily(preparedWindPos, windToX, yAfterSlope, u, 28);
    return followOneSidedFamily(preparedWindPos, windToX, yAfterSlope, 0, 2); // trivial
  }, [effective.windComponentKt, preparedWindNeg, preparedWindPos, yAfterSlope]);

  const yAfterWind = windFollow?.y ?? yAfterSlope;

  const windTracePts: Pt[] = windFollow
    ? windFollow.pts
    : [{ x: windToX(0), y: yAfterSlope }, { x: windToX(effective.windComponentKt), y: yAfterSlope }];

  /** ===== Read-off to distance axis ===== */
  const distanceAxisX = panels.mainGrid.x + panels.mainGrid.w;
  const toDistanceAxisPt: Pt = { x: distanceAxisX, y: yAfterWind };
  const windToDistanceTracePts: Pt[] = [...windTracePts, toDistanceAxisPt];
  const approxDistanceM = yToDistanceM(yAfterWind);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
          {/* Inputs */}
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-900">Inputs</h2>
            <p className="mt-1 text-xs text-slate-600">
              Conventions: slope + = UP / - = DOWN, wind + = HEAD / - = TAIL
            </p>

            <div className="mt-4 grid gap-4">
              <FieldNumber
                label="Airfield pressure height (ft) (0–6000)"
                value={effective.pressureHeightFt}
                min={0}
                max={6000}
                step={50}
                onChange={(v) => setInputs((p) => ({ ...p, pressureHeightFt: v }))}
              />
              <FieldNumber
                label="Shade temperature (°C) (-10–50)"
                value={effective.shadeTempC}
                min={-10}
                max={50}
                step={1}
                onChange={(v) => setInputs((p) => ({ ...p, shadeTempC: v }))}
              />
              <FieldNumber
                label="Slope (%)   (+UP / -DOWN) (-2–6)"
                value={effective.slopePercent}
                min={-2}
                max={6}
                step={1}
                onChange={(v) => setInputs((p) => ({ ...p, slopePercent: v }))}
              />
              <FieldNumber
                label="Wind component (kt)   (+HEAD / -TAIL) (-5–20)"
                value={effective.windComponentKt}
                min={-5}
                max={20}
                step={1}
                onChange={(v) => setInputs((p) => ({ ...p, windComponentKt: v }))}
              />
              <FieldNumber
                label="Landing weight (kg) — climb-limit check only"
                value={effective.landingWeightKg}
                min={800}
                max={1200}
                step={5}
                onChange={(v) => setInputs((p) => ({ ...p, landingWeightKg: v }))}
              />
            </div>

          </section>

          {/* Chart */}
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="relative w-full aspect-[1024/723] bg-white">
              <svg
                className="absolute inset-0 w-full h-full"
                viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
                preserveAspectRatio="xMidYMid meet"
              >
                {SHOW_REFERENCE_IMAGE && (
                  <image
                    href={REFERENCE_IMAGE_SRC}
                    x={0}
                    y={0}
                    width={VIEWBOX_W}
                    height={VIEWBOX_H}
                    preserveAspectRatio="xMidYMid meet"
                    opacity={0.92}
                  />
                )}

                <defs>
                  <marker
                    id="arrowRed"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626" />
                  </marker>
                  <marker
                    id="arrowBlue"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" />
                  </marker>
                </defs>

                {/* MAIN red trace: temp -> PH -> slope REF */}
                <path
                  d={buildPathD(phMainTrace)}
                  fill="none"
                  stroke="rgba(220,38,38,0.85)"
                  strokeWidth={2.8}
                  strokeDasharray="8 6"
                  markerEnd="url(#arrowRed)"
                  pointerEvents="none"
                />

                {/* Climb split + read-off */}
                {needsClimbCheck && (
                  <>
                    <path
                      d={buildPathD(climbBranch)}
                      fill="none"
                      stroke="rgba(37,99,235,0.85)"
                      strokeWidth={2.4}
                      strokeDasharray="6 6"
                      markerEnd="url(#arrowBlue)"
                      pointerEvents="none"
                    />

                    <path
                      d={buildPathD(climbReadLine)}
                      fill="none"
                      stroke={climbExceeded ? "rgba(220,38,38,0.95)" : "rgba(37,99,235,0.95)"}
                      strokeWidth={2.6}
                      pointerEvents="none"
                    />

                    <line
                      x1={panels.climbYAxis.x + panels.climbYAxis.w / 2 - 8}
                      y1={climbY}
                      x2={panels.climbYAxis.x + panels.climbYAxis.w / 2 + 8}
                      y2={climbY}
                      stroke={climbExceeded ? "rgba(220,38,38,0.95)" : "rgba(37,99,235,0.95)"}
                      strokeWidth={2.2}
                      pointerEvents="none"
                    />

                    <SvgText
                      x={panels.climbYAxis.x + panels.climbYAxis.w / 2 + 12}
                      y={climbY - 6}
                      size={11}
                      fill={climbExceeded ? "#dc2626" : "#2563eb"}
                    >
                      climb limit: {climbLabel}
                    </SvgText>
                  </>
                )}

                {/* Slope trace */}
                <path
                  d={buildPathD(slopeTracePts)}
                  fill="none"
                  stroke="rgba(220,38,38,0.78)"
                  strokeWidth={2.6}
                  markerEnd="url(#arrowRed)"
                  pointerEvents="none"
                />

                {/* Wind trace + horizontal to distance axis */}
                <path
                  d={buildPathD(windToDistanceTracePts)}
                  fill="none"
                  stroke="rgba(220,38,38,0.78)"
                  strokeWidth={2.6}
                  markerEnd="url(#arrowRed)"
                  pointerEvents="none"
                />

                {/* Right-axis read-off tick + landing distance label */}
                <g pointerEvents="none">
                  <line
                    x1={distanceAxisX - 10}
                    y1={yAfterWind}
                    x2={distanceAxisX + 10}
                    y2={yAfterWind}
                    stroke="rgba(220,38,38,0.95)"
                    strokeWidth={2.4}
                  />
                  <SvgText x={distanceAxisX + 14} y={yAfterWind - 6} size={11} fill="#dc2626">
                    {Math.round(approxDistanceM)} m
                  </SvgText>
                </g>
              </svg>
            </div>

            <div className="px-4 py-3 text-[11px] text-slate-600">
              Image URL should load directly at:{" "}
              <code className="text-slate-900">/charts/workbook_v3_0a/figure_4.png</code>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

/** =========================
 *  UI bits
 *  ========================= */
function FieldNumber({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="grid gap-1">
      <label className="text-xs font-medium text-slate-700">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** =========================
 *  SVG helper
 *  ========================= */
function SvgText({
  x,
  y,
  children,
  size = 12,
  weight = 600,
  rotate,
  fill = "rgba(0,0,0,0.75)",
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  size?: number;
  weight?: number;
  rotate?: number;
  fill?: string;
}) {
  const transform = rotate != null ? `rotate(${rotate} ${x} ${y})` : undefined;
  return (
    <text
      x={x}
      y={y}
      fill={fill}
      fontSize={size}
      fontWeight={weight}
      fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
      transform={transform}
    >
      {children}
    </text>
  );
}
