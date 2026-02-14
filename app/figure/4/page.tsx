"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type DigMode = "PH" | "SLOPE" | "WIND";
type DigStore = Record<number, Pt[]>;

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
function inRect(p: Pt, r: Rect) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const DIG_STORAGE_KEY = "avichartsolver_fig4_digitiser_v1";

function normalizePointArray(maybePts: unknown): Pt[] {
  if (!Array.isArray(maybePts)) return [];
  const out: Pt[] = [];
  for (const p of maybePts) {
    if (!p || typeof p !== "object") continue;
    const x = Number((p as { x?: number }).x);
    const y = Number((p as { y?: number }).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y });
  }
  return out;
}

function normalizeDigStore(maybeStore: unknown): DigStore {
  if (!maybeStore || typeof maybeStore !== "object") return {};
  const out: DigStore = {};
  for (const [key, value] of Object.entries(maybeStore as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const pts = normalizePointArray(value);
    if (pts.length) out[id] = pts;
  }
  return out;
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
 *  Digitised data (fallback)
 *  - PH has real fallback.
 *  - SLOPE/WIND fallback is intentionally minimal; you’ll digitise your 14/12 curve sets.
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

/** =========================
 *  Store -> active families
 *  ========================= */
function storeToFamilies(store: DigStore, fallback: LineFamily[]) {
  const fromStore: LineFamily[] = Object.entries(store)
    .map(([k, pts]) => ({ value: Number(k), pts }))
    .filter((l) => l.pts.length >= 2)
    .sort((a, b) => a.value - b.value);

  return fromStore.length ? fromStore : fallback;
}

function splitFamiliesBySign(family: LineFamily[]) {
  return {
    neg: family.filter((l) => l.value < 0),
    pos: family.filter((l) => l.value > 0),
  };
}

/** =========================
 *  Digitiser ID sets (your request)
 *  ========================= */
const DIG_IDS = {
  PH: [0, 2000, 4000, 6000],
  SLOPE: [-7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7],
  WIND: [-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6],
} as const;

function isSideOkForClick(mode: DigMode, id: number, p: Pt) {
  if (mode === "SLOPE") {
    const refX = FIG4.refs.slopeRefX;
    if (id < 0) return p.x <= refX + 1.0; // DOWN ids: left side
    if (id > 0) return p.x >= refX - 1.0; // UP ids: right side
  }
  if (mode === "WIND") {
    const refX = FIG4.refs.windRefX;
    if (id < 0) return p.x <= refX + 1.0; // TAIL ids: left side
    if (id > 0) return p.x >= refX - 1.0; // HEAD ids: right side
  }
  return true;
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

  const svgRef = useRef<SVGSVGElement | null>(null);

  const { w: VIEWBOX_W, h: VIEWBOX_H } = FIG4.viewBox;
  const { panels, refs } = FIG4;

  const REFERENCE_IMAGE_SRC = "/charts/workbook_v3_0a/figure_4.png";
  const SHOW_REFERENCE_IMAGE = true;

  /** ===== Multi-mode digitiser ===== */
  const [digEnabled, setDigEnabled] = useState(false);
  const [digMode, setDigMode] = useState<DigMode>("PH");
  const [digValue, setDigValue] = useState<number>(4000);

  const [digPhStore, setDigPhStore] = useState<DigStore>({});
  const [digSlopeStore, setDigSlopeStore] = useState<DigStore>({});
  const [digWindStore, setDigWindStore] = useState<DigStore>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DIG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { ph?: unknown; slope?: unknown; wind?: unknown };
      setDigPhStore(normalizeDigStore(parsed?.ph));
      setDigSlopeStore(normalizeDigStore(parsed?.slope));
      setDigWindStore(normalizeDigStore(parsed?.wind));
    } catch {
      // ignore invalid storage
    }
  }, []);

  useEffect(() => {
    try {
      const payload = { ph: digPhStore, slope: digSlopeStore, wind: digWindStore };
      window.localStorage.setItem(DIG_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  }, [digPhStore, digSlopeStore, digWindStore]);

  const activePhLines = useMemo(
    () => storeToFamilies(digPhStore, PH_LINES),
    [digPhStore]
  );
  const activeSlopeCurves = useMemo(
    () => storeToFamilies(digSlopeStore, SLOPE_CURVES),
    [digSlopeStore]
  );
  const activeWindCurves = useMemo(
    () => storeToFamilies(digWindStore, WIND_CURVES),
    [digWindStore]
  );

  const activeDigitiser = useMemo(() => {
    if (digMode === "PH") {
      return {
        store: digPhStore,
        setStore: setDigPhStore,
        panel: panels.phTempNomogram,
        exportName: "PH_LINES",
      } as const;
    }
    if (digMode === "SLOPE") {
      return {
        store: digSlopeStore,
        setStore: setDigSlopeStore,
        panel: panels.slopeGrid,
        exportName: "SLOPE_CURVES",
      } as const;
    }
    return {
      store: digWindStore,
      setStore: setDigWindStore,
      panel: panels.windGrid,
      exportName: "WIND_CURVES",
    } as const;
  }, [digMode, digPhStore, digSlopeStore, digWindStore, panels]);

  const digPointsCount = useMemo(
    () => activeDigitiser.store[digValue]?.length ?? 0,
    [activeDigitiser.store, digValue]
  );

  const exportSnippet = useMemo(() => {
    const lines: LineFamily[] = Object.entries(activeDigitiser.store)
      .map(([k, pts]) => ({ value: Number(k), pts }))
      .filter((l) => l.pts.length >= 2)
      .sort((a, b) => a.value - b.value);

    return `const ${activeDigitiser.exportName}: LineFamily[] = ${JSON.stringify(lines, null, 2)};\n`;
  }, [activeDigitiser.store, activeDigitiser.exportName]);

  const canCopySnippet = Object.keys(activeDigitiser.store).length > 0;

  const exportAllSnippet = useMemo(() => {
    const build = (name: string, store: DigStore) => {
      const lines: LineFamily[] = Object.entries(store)
        .map(([k, pts]) => ({ value: Number(k), pts }))
        .filter((l) => l.pts.length >= 2)
        .sort((a, b) => a.value - b.value);
      return `const ${name}: LineFamily[] = ${JSON.stringify(lines, null, 2)};`;
    };
    return `${build("PH_LINES", digPhStore)}\n\n${build("SLOPE_CURVES", digSlopeStore)}\n\n${build(
      "WIND_CURVES",
      digWindStore
    )}\n`;
  }, [digPhStore, digSlopeStore, digWindStore]);

  const hasAnyDigData =
    Object.keys(digPhStore).length > 0 ||
    Object.keys(digSlopeStore).length > 0 ||
    Object.keys(digWindStore).length > 0;

  const digDisplayPoints = useMemo(() => {
    const entries = Object.entries(activeDigitiser.store) as Array<[string, Pt[]]>;
    const points: Array<{ id: number; pt: Pt }> = [];
    for (const [idStr, pts] of entries) {
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      for (const pt of pts) points.push({ id, pt });
    }
    return points;
  }, [activeDigitiser.store]);

  const digPointColor = useCallback(
    (id: number) => {
      if (digMode === "PH") return "#0f172a"; // slate-900
      if (digMode === "SLOPE") return id < 0 ? "#2563eb" : "#dc2626"; // blue for DOWN, red for UP
      return id < 0 ? "#2563eb" : "#dc2626"; // wind: blue tail, red head
    },
    [digMode]
  );

  const onSvgClick = useCallback(
    (e: React.MouseEvent) => {
      if (!digEnabled) return;

      const svg = svgRef.current;
      if (!svg) return;

      const ctm = svg.getScreenCTM();
      if (!ctm) return;

      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const clickPt: Pt = { x: p.x, y: p.y };

      if (!inRect(clickPt, activeDigitiser.panel)) return;
      if (!isSideOkForClick(digMode, digValue, clickPt)) return;

      activeDigitiser.setStore((prev: DigStore) => {
        const existing = prev[digValue] ?? [];
        return { ...prev, [digValue]: [...existing, clickPt] };
      });
    },
    [digEnabled, activeDigitiser, digValue, digMode]
  );

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

  const slopeMissing =
    (effective.slopePercent < 0 && preparedSlopeNeg.length < 2) ||
    (effective.slopePercent > 0 && preparedSlopePos.length < 2);

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

  const windMissing =
    (effective.windComponentKt < 0 && preparedWindNeg.length < 2) ||
    (effective.windComponentKt > 0 && preparedWindPos.length < 2);

  const windTracePts: Pt[] = windFollow
    ? windFollow.pts
    : [{ x: windToX(0), y: yAfterSlope }, { x: windToX(effective.windComponentKt), y: yAfterSlope }];

  /** ===== Read-off to distance axis ===== */
  const distanceAxisX = panels.mainGrid.x + panels.mainGrid.w;
  const toDistanceAxisPt: Pt = { x: distanceAxisX, y: yAfterWind };
  const windToDistanceTracePts: Pt[] = [...windTracePts, toDistanceAxisPt];
  const approxDistanceM = yToDistanceM(yAfterWind);

  /** ===== Digitiser UI options ===== */
  const modeOptions: { label: string; value: DigMode }[] = [
    { label: "PH lines", value: "PH" },
    { label: "Slope panel lines (14 ids)", value: "SLOPE" },
    { label: "Wind panel lines (12 ids)", value: "WIND" },
  ];

  const lineOptions = digMode === "PH" ? [...DIG_IDS.PH] : digMode === "SLOPE" ? [...DIG_IDS.SLOPE] : [...DIG_IDS.WIND];

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

            {(slopeMissing || windMissing) && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                <div className="font-semibold">Digitiser data missing for this sign</div>
                <ul className="mt-1 list-disc pl-4">
                  {slopeMissing && (
                    <li>
                      Slope: you entered {effective.slopePercent}% but you haven’t digitised enough{" "}
                      {effective.slopePercent < 0 ? "DOWN (-7..-1)" : "UP (1..7)"} curves yet.
                    </li>
                  )}
                  {windMissing && (
                    <li>
                      Wind: you entered {effective.windComponentKt} kt but you haven’t digitised enough{" "}
                      {effective.windComponentKt < 0 ? "TAIL (-6..-1)" : "HEAD (1..6)"} curves yet.
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* Digitiser controls */}
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-900">Digitiser</div>
                  <div className="text-[11px] text-slate-600">
                    Enable → pick mode + id → click along the curve inside that panel.
                    <br />
                    Slope ids: DOWN <span className="font-semibold">-7..-1</span> (left of ref line), UP{" "}
                    <span className="font-semibold">1..7</span> (right of ref line). Wind ids: TAIL{" "}
                    <span className="font-semibold">-6..-1</span>, HEAD <span className="font-semibold">1..6</span>.
                    <br />
                    Points are saved in your browser. Copy the export snippet when done.
                  </div>
                </div>
                <button
                  className={`h-9 rounded-xl px-3 text-xs font-semibold ring-1 ${
                    digEnabled
                      ? "bg-emerald-600 text-white ring-emerald-700"
                      : "bg-white text-slate-800 ring-slate-300"
                  }`}
                  onClick={() => setDigEnabled((v) => !v)}
                  type="button"
                >
                  {digEnabled ? "Digitiser: ON" : "Digitiser: OFF"}
                </button>
              </div>

              <div className="mt-3 grid gap-3">
                <div className="flex items-center gap-3">
                  <label className="text-[11px] font-semibold text-slate-700">Mode</label>
                  <select
                    className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs"
                    value={digMode}
                    onChange={(e) => {
                      const m = e.target.value as DigMode;
                      setDigMode(m);
                      setDigValue(m === "PH" ? 4000 : 1);
                    }}
                    disabled={!digEnabled}
                  >
                    {modeOptions.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>

                  <label className="ml-2 text-[11px] font-semibold text-slate-700">
                    {digMode === "PH" ? "Line (ft)" : "Curve id"}
                  </label>
                  <select
                    className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs"
                    value={digValue}
                    onChange={(e) => setDigValue(Number(e.target.value))}
                    disabled={!digEnabled}
                  >
                    {lineOptions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>

                  <div className="text-[11px] text-slate-700">
                    Points: <span className="font-semibold">{digPointsCount}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    className="h-9 rounded-xl bg-white px-3 text-xs font-semibold ring-1 ring-slate-300 disabled:opacity-50"
                    disabled={!digEnabled || !digPointsCount}
                    onClick={() =>
                      activeDigitiser.setStore((prev: DigStore) => {
                        const pts = prev[digValue] ?? [];
                        return { ...prev, [digValue]: pts.slice(0, -1) };
                      })
                    }
                    type="button"
                  >
                    Undo
                  </button>

                  <button
                    className="h-9 rounded-xl bg-white px-3 text-xs font-semibold ring-1 ring-slate-300 disabled:opacity-50"
                    disabled={!digEnabled || !digPointsCount}
                    onClick={() =>
                      activeDigitiser.setStore((prev: DigStore) => {
                        const copy = { ...prev };
                        delete copy[digValue];
                        return copy;
                      })
                    }
                    type="button"
                  >
                    Clear id
                  </button>

                  <button
                    className="h-9 rounded-xl bg-white px-3 text-xs font-semibold ring-1 ring-slate-300 disabled:opacity-50"
                    disabled={!canCopySnippet}
                    onClick={() => {
                      try {
                        void navigator.clipboard?.writeText(exportSnippet);
                      } catch {
                        // ignore
                      }
                    }}
                    type="button"
                  >
                    Copy snippet
                  </button>

                  <button
                    className="h-9 rounded-xl bg-white px-3 text-xs font-semibold ring-1 ring-slate-300 disabled:opacity-50"
                    disabled={!hasAnyDigData}
                    onClick={() => {
                      try {
                        void navigator.clipboard?.writeText(exportAllSnippet);
                      } catch {
                        // ignore
                      }
                    }}
                    type="button"
                  >
                    Copy all curves
                  </button>

                  <button
                    className="h-9 rounded-xl bg-white px-3 text-xs font-semibold ring-1 ring-slate-300 disabled:opacity-50"
                    disabled={!hasAnyDigData}
                    onClick={() => {
                      setDigPhStore({});
                      setDigSlopeStore({});
                      setDigWindStore({});
                      try {
                        window.localStorage.removeItem(DIG_STORAGE_KEY);
                      } catch {
                        // ignore
                      }
                    }}
                    type="button"
                  >
                    Clear all
                  </button>
                </div>
              </div>

              {canCopySnippet && (
                <textarea
                  className="mt-3 h-36 w-full resize-none rounded-xl border border-slate-200 bg-white p-2 text-[11px] text-slate-900"
                  value={exportSnippet}
                  readOnly
                />
              )}

              {hasAnyDigData && (
                <textarea
                  className="mt-3 h-44 w-full resize-none rounded-xl border border-slate-200 bg-white p-2 text-[11px] text-slate-900"
                  value={exportAllSnippet}
                  readOnly
                />
              )}
            </div>
          </section>

          {/* Chart */}
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="relative w-full aspect-[1024/723] bg-white">
              <svg
                ref={svgRef}
                onClick={onSvgClick}
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

                {/* Digitiser points */}
                {digDisplayPoints.map(({ id, pt }, i) => {
                  const isActiveId = id === digValue;
                  return (
                    <circle
                      key={`${id}-${i}`}
                      cx={pt.x}
                      cy={pt.y}
                      r={isActiveId ? 4.5 : 3}
                      fill={digPointColor(id)}
                      opacity={isActiveId ? 0.95 : 0.45}
                      stroke="#ffffff"
                      strokeWidth={isActiveId ? 1 : 0.5}
                      pointerEvents="none"
                    />
                  );
                })}

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
