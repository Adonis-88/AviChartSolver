"use client";

import Image from "next/image";
import React, { useEffect, useMemo, useState } from "react";

/**
 * Figure 3 — Take-off Weight Calculator (Lock-based solver)
 *
 * Drawing:
 * - A-path = solid red
 * - B-path = dashed red
 * - Optional: dashed vertical "split branch" from Panel 3 to Panel 1
 *
 * Key fix implemented:
 * - Panel 1 entry X is now driven by Panel 3 density intersection X (same construction line).
 * - Panel 1 entry Y is solved by interpolating TODA isolines at that X (not a fixed cut line).
 *
 * NEW FIXES:
 * - pressureHeightFt, shadeTempC, todaM, windKnots, slopePercent are forced to whole numbers everywhere.
 * - B-limit is capped so it can never exceed 1090 kg (WEIGHT_LIMIT), and the B stop line is clamped accordingly.
 */

type Pt = { x: number; y: number };

type SurfaceKey = "refShortDry" | "longDryOrShortWet" | "longWet";

type WindKey = "twMinus5" | "hw0" | "hw10" | "hw20";
type TempKey = "-10" | "0" | "10" | "20" | "30" | "40";
type SlopeKey = "down4" | "down2" | "level0" | "up2";

type VarKey =
  | "pressureHeightFt"
  | "shadeTempC"
  | "todaM"
  | "windKnots"
  | "slopePercent"
  | "surface";

type NumericKey = Exclude<VarKey, "surface">;

type Inputs = {
  pressureHeightFt: number;
  shadeTempC: number;
  todaM: number;
  windKnots: number;
  slopePercent: number;
  surface: SurfaceKey;
};

type Locks = Record<VarKey, boolean>;

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function length(vx: number, vy: number) {
  return Math.hypot(vx, vy);
}
function roundWhole(v: number) {
  return Math.round(v);
}

// ============================
// Geometry helpers (unchanged)
// ============================

function dirFromPolyline(points: Pt[]) {
  const a = points[0];
  const b = points[points.length - 1];
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L = length(vx, vy) || 1;
  return { vx: vx / L, vy: vy / L };
}

function xAtYExtrap(points: Pt[], Y: number): number | null {
  if (points.length < 2) return null;

  const ys = points.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  if (Y >= minY && Y <= maxY) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const segMinY = Math.min(a.y, b.y);
      const segMaxY = Math.max(a.y, b.y);
      if (Y < segMinY || Y > segMaxY) continue;

      const dy = b.y - a.y;
      if (Math.abs(dy) < 1e-9) {
        if (Math.abs(a.y - Y) < 1e-6) return a.x;
        continue;
      }

      const t = (Y - a.y) / dy;
      return a.x + t * (b.x - a.x);
    }
    return null;
  }

  // Extrapolate above (smaller y)
  if (Y < minY) {
    let a = points[0];
    let b = points[1];
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      const q = points[i + 1];
      if (Math.abs(q.y - p.y) > 1e-6 || Math.abs(q.x - p.x) > 1e-6) {
        a = p;
        b = q;
        break;
      }
    }
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-9) return null;
    const t = (Y - a.y) / dy;
    return a.x + t * (b.x - a.x);
  }

  // Extrapolate below (larger y)
  if (Y > maxY) {
    let a = points[points.length - 2];
    let b = points[points.length - 1];
    for (let i = points.length - 2; i >= 0; i--) {
      const p = points[i];
      const q = points[i + 1];
      if (Math.abs(q.y - p.y) > 1e-6 || Math.abs(q.x - p.x) > 1e-6) {
        a = p;
        b = q;
        break;
      }
    }
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-9) return null;
    const t = (Y - a.y) / dy;
    return a.x + t * (b.x - a.x);
  }

  return null;
}

function yAtXExtrap(points: Pt[], X: number): number | null {
  if (points.length < 2) return null;

  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  if (X >= minX && X <= maxX) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];

      const segMinX = Math.min(a.x, b.x);
      const segMaxX = Math.max(a.x, b.x);
      if (X < segMinX || X > segMaxX) continue;

      const dx = b.x - a.x;
      if (Math.abs(dx) < 1e-9) {
        if (Math.abs(a.x - X) < 1e-6) return a.y;
        continue;
      }

      const t = (X - a.x) / dx;
      return a.y + t * (b.y - a.y);
    }
    return null;
  }

  // Extrapolate left
  if (X < minX) {
    let a = points[0];
    let b = points[1];
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      const q = points[i + 1];
      if (Math.abs(q.x - p.x) > 1e-6 || Math.abs(q.y - p.y) > 1e-6) {
        a = p;
        b = q;
        break;
      }
    }
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-9) return null;
    const t = (X - a.x) / dx;
    return a.y + t * (b.y - a.y);
  }

  // Extrapolate right
  if (X > maxX) {
    let a = points[points.length - 2];
    let b = points[points.length - 1];
    for (let i = points.length - 2; i >= 0; i--) {
      const p = points[i];
      const q = points[i + 1];
      if (Math.abs(q.x - p.x) > 1e-6 || Math.abs(q.y - p.y) > 1e-6) {
        a = p;
        b = q;
        break;
      }
    }
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-9) return null;
    const t = (X - a.x) / dx;
    return a.y + t * (b.y - a.y);
  }

  return null;
}

function intersectLineWithPolyline(
  P: Pt,
  v: { vx: number; vy: number },
  poly: Pt[]
): Pt | null {
  const x1 = P.x;
  const y1 = P.y;
  const x2 = P.x + v.vx;
  const y2 = P.y + v.vy;

  function intersectSegment(a: Pt, b: Pt): { pt: Pt; tLine: number } | null {
    const x3 = a.x,
      y3 = a.y,
      x4 = b.x,
      y4 = b.y;

    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;

    const px =
      ((x1 * y2 - y1 * x2) * (x3 - x4) -
        (x1 - x2) * (x3 * y4 - y3 * x4)) /
      den;
    const py =
      ((x1 * y2 - y1 * x2) * (y3 - y4) -
        (y1 - y2) * (x3 * y4 - y3 * x4)) /
      den;

    const minX = Math.min(x3, x4) - 1e-6;
    const maxX = Math.max(x3, x4) + 1e-6;
    const minY = Math.min(y3, y4) - 1e-6;
    const maxY = Math.max(y3, y4) + 1e-6;
    if (px < minX || px > maxX || py < minY || py > maxY) return null;

    let tLine: number;
    if (Math.abs(v.vx) >= Math.abs(v.vy)) tLine = (px - P.x) / (v.vx || 1e-9);
    else tLine = (py - P.y) / (v.vy || 1e-9);

    return { pt: { x: px, y: py }, tLine };
  }

  let best: { pt: Pt; tLine: number } | null = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const hit = intersectSegment(poly[i], poly[i + 1]);
    if (!hit) continue;
    if (hit.tLine < 0) continue;
    if (!best || hit.tLine < best.tLine) best = hit;
  }
  return best?.pt ?? null;
}

// ============================
// Generic iso-family helpers
// ============================

type IsoFamily<K extends string> = {
  values: Record<K, number>;
  lines: Record<K, Pt[]>;
};

function sampleIsoFamilyAtY<K extends string>(family: IsoFamily<K>, y: number) {
  const keys = Object.keys(family.lines) as K[];
  const samples = keys
    .map((k) => {
      const x = xAtYExtrap(family.lines[k], y);
      if (x == null) return null;
      return { key: k, v: family.values[k], x };
    })
    .filter(Boolean) as Array<{ key: K; v: number; x: number }>;

  samples.sort((a, b) => a.v - b.v);
  return samples;
}

function interpolateXFromValueAtY<K extends string>(
  family: IsoFamily<K>,
  value: number,
  y: number
) {
  const samples = sampleIsoFamilyAtY(family, y);
  if (samples.length < 2) return { x: null as number | null, bracket: "n/a" };

  let low = samples[0];
  let high = samples[samples.length - 1];

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (value >= a.v && value <= b.v) {
      low = a;
      high = b;
      break;
    }
  }

  const t = clamp((value - low.v) / (high.v - low.v || 1), 0, 1);
  return {
    x: lerp(low.x, high.x, t),
    bracket: `${low.v} -> ${high.v} (t=${t.toFixed(2)})`,
  };
}

// sample at X + interpolate Y from iso-values at X
function sampleIsoFamilyAtX<K extends string>(family: IsoFamily<K>, x: number) {
  const keys = Object.keys(family.lines) as K[];
  const samples = keys
    .map((k) => {
      const y = yAtXExtrap(family.lines[k], x);
      if (y == null) return null;
      return { key: k, v: family.values[k], y };
    })
    .filter(Boolean) as Array<{ key: K; v: number; y: number }>;

  samples.sort((a, b) => a.v - b.v);
  return samples;
}

function interpolateYFromValueAtX<K extends string>(
  family: IsoFamily<K>,
  value: number,
  x: number
) {
  const samples = sampleIsoFamilyAtX(family, x);
  if (samples.length < 2) return { y: null as number | null, bracket: "n/a" };

  let low = samples[0];
  let high = samples[samples.length - 1];

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (value >= a.v && value <= b.v) {
      low = a;
      high = b;
      break;
    }
  }

  const t = clamp((value - low.v) / (high.v - low.v || 1), 0, 1);
  return {
    y: lerp(low.y, high.y, t),
    bracket: `${low.v} -> ${high.v} (t=${t.toFixed(2)})`,
  };
}

// ============================
// 1D bisection solver (best-effort)
// ============================

function solveBisection(opts: {
  f: (x: number) => number;
  lo: number;
  hi: number;
  maxIter?: number;
  tol?: number;
}) {
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-2;

  let lo = opts.lo;
  let hi = opts.hi;

  let flo = opts.f(lo);
  let fhi = opts.f(hi);

  if (flo === 0) return { ok: true as const, x: lo, bracketed: true as const };
  if (fhi === 0) return { ok: true as const, x: hi, bracketed: true as const };

  const bracketed = flo * fhi <= 0;
  if (!bracketed) {
    const best = Math.abs(flo) < Math.abs(fhi) ? lo : hi;
    return { ok: false as const, x: best, bracketed: false as const };
  }

  for (let i = 0; i < maxIter; i++) {
    const mid = 0.5 * (lo + hi);
    const fmid = opts.f(mid);
    if (Math.abs(fmid) < tol || Math.abs(hi - lo) < tol) {
      return { ok: true as const, x: mid, bracketed: true as const };
    }
    if (flo * fmid <= 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }

  return { ok: true as const, x: 0.5 * (lo + hi), bracketed: true as const };
}

// ============================
// Main Page constants
// ============================

const VIEWBOX_W = 723;
const VIEWBOX_H = 1024;

// Panels
const PANEL_1 = { x: 118, y: 179, w: 218, h: 218 };
const PANEL_2 = { x: 448, y: 179, w: 218, h: 218 };
const PANEL_3 = { x: 118, y: 473, w: 218, h: 218 };
const PANEL_4 = { x: 448, y: 473, w: 218, h: 218 };

// Shared weight axis calibration
const WT_850: Pt = { x: 448, y: 691 };
const WT_1100: Pt = { x: 448, y: 473 };

function yFromWeight(w: number) {
  const w0 = 850;
  const w1 = 1100;
  return WT_850.y + ((w - w0) * (WT_1100.y - WT_850.y)) / (w1 - w0);
}
function weightFromY(y: number) {
  const w0 = 850;
  const w1 = 1100;
  return w0 + ((y - WT_850.y) * (w1 - w0)) / (WT_1100.y - WT_850.y);
}

const WEIGHT_LIMIT = 1090;
const yLimit = yFromWeight(WEIGHT_LIMIT);

// Centre surface connector
const X_REF = 346.7;

const GUIDE_RAILS: Record<"top" | "mid1" | "mid2" | "bottom", Pt[]> = {
  top: [
    { x: 346.7, y: 178 },
    { x: 396, y: 277 },
  ],
  mid1: [
    { x: 346.7, y: 248 },
    { x: 381, y: 315 },
  ],
  mid2: [
    { x: 346.7, y: 311 },
    { x: 372, y: 367 },
  ],
  bottom: [
    { x: 346.7, y: 397.3 },
    { x: 370, y: 397.3 },
  ],
};

const SURFACE_RAILS: Record<SurfaceKey, Pt[]> = {
  refShortDry: [
    { x: 346.7, y: 178 },
    { x: 346.7, y: 397.3 },
  ],
  longDryOrShortWet: [
    { x: 370, y: 225 },
    { x: 366, y: 250 },
    { x: 363, y: 280 },
    { x: 358, y: 330 },
    { x: 354, y: 380 },
    { x: 353, y: 397.3 },
  ],
  longWet: [
    { x: 396, y: 277 },
    { x: 394, y: 280 },
    { x: 390, y: 290 },
    { x: 386, y: 300 },
    { x: 382.5, y: 310 },
    { x: 380, y: 320 },
    { x: 377.5, y: 330 },
    { x: 376, y: 340 },
    { x: 373, y: 360 },
    { x: 370.5, y: 380 },
    { x: 369.1, y: 397.3 },
  ],
};

function solveSurfaceConnector(params: { yEntry: number; surface: SurfaceKey }) {
  const { yEntry, surface } = params;

  if (surface === "refShortDry") {
    return {
      entry: { x: X_REF, y: yEntry },
      hit: { x: X_REF, y: yEntry },
      dir: { vx: 1, vy: 0 },
    };
  }

  const rails = [
    { name: "top" as const, pts: GUIDE_RAILS.top },
    { name: "mid1" as const, pts: GUIDE_RAILS.mid1 },
    { name: "mid2" as const, pts: GUIDE_RAILS.mid2 },
    { name: "bottom" as const, pts: GUIDE_RAILS.bottom },
  ]
    .map((r) => ({ ...r, yAtRef: yAtXExtrap(r.pts, X_REF) }))
    .filter((r) => r.yAtRef != null) as Array<{
    name: "top" | "mid1" | "mid2" | "bottom";
    pts: Pt[];
    yAtRef: number;
  }>;

  rails.sort((a, b) => a.yAtRef - b.yAtRef);

  let upper = rails[0];
  let lower = rails[rails.length - 1];

  for (let i = 0; i < rails.length - 1; i++) {
    const a = rails[i];
    const b = rails[i + 1];
    if (yEntry >= a.yAtRef && yEntry <= b.yAtRef) {
      upper = a;
      lower = b;
      break;
    }
  }

  const tRaw = (yEntry - upper.yAtRef) / (lower.yAtRef - upper.yAtRef || 1);
  const t = clamp(tRaw, 0, 1);

  const du = dirFromPolyline(upper.pts);
  const dl = dirFromPolyline(lower.pts);

  let vx = lerp(du.vx, dl.vx, t);
  let vy = lerp(du.vy, dl.vy, t);

  const L = length(vx, vy) || 1;
  vx /= L;
  vy /= L;

  const entry = { x: X_REF, y: yEntry };

  // Force downward-ish direction
  if (vy < 0) {
    vx *= -1;
    vy *= -1;
  }

  const hit = intersectLineWithPolyline(
    entry,
    { vx, vy },
    SURFACE_RAILS[surface]
  );

  return {
    entry,
    hit,
    dir: { vx, vy },
  };
}

// ============================
// Panel 4: WIND lines
// ============================

const WIND_VALUES: Record<WindKey, number> = {
  twMinus5: -5,
  hw0: 0,
  hw10: 10,
  hw20: 20,
};

const WIND_ISOLINES: Record<WindKey, Pt[]> = {
  twMinus5: [
    { x: PANEL_4.x + 10, y: yLimit + 2 },
    { x: PANEL_4.x + 137, y: PANEL_4.y + PANEL_4.h },
  ],
  hw0: [
    { x: PANEL_4.x + 59.5, y: yLimit + 2 },
    { x: PANEL_4.x + 187, y: PANEL_4.y + PANEL_4.h },
  ],
  hw10: [
    { x: PANEL_4.x + 94.5, y: yLimit + 2 },
    { x: PANEL_4.x + 219, y: PANEL_4.y + PANEL_4.h - 5.5 },
  ],
  hw20: [
    { x: PANEL_4.x + 130, y: yLimit + 2 },
    { x: PANEL_4.x + 219, y: PANEL_4.y + PANEL_4.h - 63 },
  ],
};

function yFromWindAtX(wind: number, xDrop: number) {
  const keys = Object.keys(WIND_ISOLINES) as WindKey[];
  const samples = keys
    .map((k) => {
      const y = yAtXExtrap(WIND_ISOLINES[k], xDrop);
      if (y == null) return null;
      return { wind: WIND_VALUES[k], y };
    })
    .filter(Boolean) as Array<{ wind: number; y: number }>;

  if (samples.length < 2) return { y: null as number | null };

  samples.sort((a, b) => a.wind - b.wind);

  let low = samples[0];
  let high = samples[samples.length - 1];

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (wind >= a.wind && wind <= b.wind) {
      low = a;
      high = b;
      break;
    }
  }

  const t = clamp((wind - low.wind) / (high.wind - low.wind || 1), 0, 1);
  return { y: lerp(low.y, high.y, t) };
}

// ============================
// Panel 3: PH + temp => B limit
// ============================

const PH_SL: Pt = { x: PANEL_3.x, y: PANEL_3.y + PANEL_3.h };
const PH_8000: Pt = { x: PANEL_3.x, y: PANEL_3.y + 44 };

function yFromPressureHeightFt(ph: number) {
  const ph0 = 0;
  const ph1 = 8000;
  return PH_SL.y + ((ph - ph0) * (PH_8000.y - PH_SL.y)) / (ph1 - ph0);
}

const TEMP_VALUES: Record<TempKey, number> = {
  "-10": -10,
  "0": 0,
  "10": 10,
  "20": 20,
  "30": 30,
  "40": 40,
};

const TEMP_ISOLINES: Record<TempKey, Pt[]> = {
  "-10": [
    { x: PANEL_3.x + 218.5, y: PANEL_3.y + PANEL_3.h - 30.5 },
    { x: PANEL_3.x, y: PANEL_3.y + 0 },
  ],
  "0": [
    { x: PANEL_3.x + 217, y: PANEL_3.y + PANEL_3.h - 16 },
    { x: PANEL_3.x, y: PANEL_3.y + 16 },
  ],
  "10": [
    { x: PANEL_3.x + 217.5, y: PANEL_3.y + PANEL_3.h },
    { x: PANEL_3.x, y: PANEL_3.y + 31.5 },
  ],
  "20": [
    { x: PANEL_3.x + 200, y: PANEL_3.y + PANEL_3.h },
    { x: PANEL_3.x, y: PANEL_3.y + 47 },
  ],
  "30": [
    { x: PANEL_3.x + 182, y: PANEL_3.y + PANEL_3.h },
    { x: PANEL_3.x, y: PANEL_3.y + 62 },
  ],
  "40": [
    { x: PANEL_3.x + 164, y: PANEL_3.y + PANEL_3.h },
    { x: PANEL_3.x, y: PANEL_3.y + 78.5 },
  ],
};

const HOT_WEIGHT_LIMIT_LINE: Pt[] = [
  { x: PANEL_3.x + 103.5, y: PANEL_3.y + 8 },
  { x: PANEL_3.x, y: PANEL_3.y + 218.5 },
];

const TEMP_FAMILY: IsoFamily<TempKey> = {
  values: TEMP_VALUES,
  lines: TEMP_ISOLINES,
};

function solveBWeightLimit(params: {
  pressureHeightFt: number;
  shadeTempC: number;
}) {
  const { pressureHeightFt, shadeTempC } = params;

  const yPH = yFromPressureHeightFt(pressureHeightFt);
  const yPHClamped = clamp(yPH, PANEL_3.y, PANEL_3.y + PANEL_3.h);

  const tempSolve = interpolateXFromValueAtY(
    TEMP_FAMILY,
    shadeTempC,
    yPHClamped
  );
  if (tempSolve.x == null)
    return { ok: false as const, reason: "temp intersection failed" };

  const ptIntersect: Pt = { x: tempSolve.x, y: yPHClamped };

  const yTop = PANEL_3.y; // corresponds to 1100 kg on shared axis
  const yHot = yAtXExtrap(HOT_WEIGHT_LIMIT_LINE, ptIntersect.x);

  let yStop = yTop;
  let hitHot = false;

  if (yHot != null) {
    const within = yHot >= yTop && yHot <= ptIntersect.y;
    if (within) {
      yStop = yHot;
      hitHot = true;
    }
  }

  // NEW: enforce that B-limit can never exceed 1090 kg.
  // Higher weight => smaller y. So clamp stop y to be at/under the 1090kg line (i.e. y >= yLimit).
  yStop = Math.max(yStop, yLimit);

  const bWeight = Math.min(weightFromY(yStop), WEIGHT_LIMIT);

  return {
    ok: true as const,
    yPH: yPHClamped,
    ptPH: { x: PANEL_3.x, y: yPHClamped },
    ptIntersect,
    yStop,
    hitHot,
    bWeight,
  };
}

// ============================
// Panel 2: slope => xDrop
// ============================

const SLOPE_VALUES: Record<SlopeKey, number> = {
  down4: -4,
  down2: -2,
  level0: 0,
  up2: 2,
};

const SLOPE_ISOLINES: Record<SlopeKey, Pt[]> = {
  down4: [
    { x: PANEL_2.x, y: PANEL_2.y + 43 },
    { x: PANEL_2.x + 191.5, y: PANEL_2.y + PANEL_2.h },
  ],
  down2: [
    { x: PANEL_2.x, y: PANEL_2.y + 17 },
    { x: PANEL_2.x + 210, y: PANEL_2.y + PANEL_2.h },
  ],
  level0: [
    { x: PANEL_2.x + 15.5, y: PANEL_2.y },
    { x: PANEL_2.x + 219, y: PANEL_2.y + PANEL_2.h - 11 },
  ],
  up2: [
    { x: PANEL_2.x + 78, y: PANEL_2.y },
    { x: PANEL_2.x + 219, y: PANEL_2.y + PANEL_2.h - 65.5 },
  ],
};

const SLOPE_FAMILY: IsoFamily<SlopeKey> = {
  values: SLOPE_VALUES,
  lines: SLOPE_ISOLINES,
};

function xFromSlopeAtY(slopePercent: number, y: number) {
  const s = clamp(slopePercent, -4, 2);
  return interpolateXFromValueAtY(SLOPE_FAMILY, s, y);
}

// ============================
// Panel 1: TODA family
// ============================

type TODAKey =
  | "t400"
  | "t500"
  | "t600"
  | "t700"
  | "t800"
  | "t900"
  | "t1000"
  | "t1100"
  | "t1200"
  | "t1300"
  | "t1400"
  | "t1500";

const TODA_VALUES: Record<TODAKey, number> = {
  t400: 400,
  t500: 500,
  t600: 600,
  t700: 700,
  t800: 800,
  t900: 900,
  t1000: 1000,
  t1100: 1100,
  t1200: 1200,
  t1300: 1300,
  t1400: 1400,
  t1500: 1500,
};

const TODA_ISOLINES: Record<TODAKey, Pt[]> = {
  t400: [
    { x: PANEL_1.x + 219, y: PANEL_1.y + 180 },
    { x: PANEL_1.x + 186.5, y: PANEL_1.y + PANEL_1.h },
  ],
  t500: [
    { x: PANEL_1.x + 219, y: PANEL_1.y + 119 },
    { x: PANEL_1.x + 132, y: PANEL_1.y + PANEL_1.h },
  ],
  t600: [
    { x: PANEL_1.x + 219, y: PANEL_1.y + 65 },
    { x: PANEL_1.x + 85, y: PANEL_1.y + PANEL_1.h },
  ],
  t700: [
    { x: PANEL_1.x + 219, y: PANEL_1.y + 20 },
    { x: PANEL_1.x + 45, y: PANEL_1.y + PANEL_1.h },
  ],
  t800: [
    { x: PANEL_1.x + 199.2, y: PANEL_1.y },
    { x: PANEL_1.x + 7.5, y: PANEL_1.y + PANEL_1.h },
  ],
  t900: [
    { x: PANEL_1.x + 174, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 21 },
  ],
  t1000: [
    { x: PANEL_1.x + 152, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 44 },
  ],
  t1100: [
    { x: PANEL_1.x + 126, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 75 },
  ],
  t1200: [
    { x: PANEL_1.x + 110, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 94 },
  ],
  t1300: [
    { x: PANEL_1.x + 93, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 112 },
  ],
  t1400: [
    { x: PANEL_1.x + 83, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 123 },
  ],
  t1500: [
    { x: PANEL_1.x + 75, y: PANEL_1.y },
    { x: PANEL_1.x, y: PANEL_1.y + PANEL_1.h - 133 },
  ],
};

const TODA_FAMILY: IsoFamily<TODAKey> = {
  values: TODA_VALUES,
  lines: TODA_ISOLINES,
};

function yFromTODAAtX(todaM: number, xEntry: number) {
  const t = clamp(todaM, 400, 1500);
  return interpolateYFromValueAtX(TODA_FAMILY, t, xEntry);
}

// ============================
// A limit solver (unchanged logic)
// ============================

function solveAWeightLimit(params: {
  todaM: number;
  surface: SurfaceKey;
  slopePercent: number;
  windKnots: number;
  densityX: number | null;
}) {
  const { todaM, surface, slopePercent, windKnots, densityX } = params;

  // Panel 1: X comes from Panel 3 (vertical construction line)
  let xEntry = densityX ?? PANEL_1.x + PANEL_1.w * 0.5;
  xEntry = clamp(xEntry, PANEL_1.x, PANEL_1.x + PANEL_1.w);

  // Panel 1: Y comes from TODA isolines at that X
  const todaYSolve = yFromTODAAtX(todaM, xEntry);
  if (todaYSolve.y == null)
    return { ok: false as const, reason: "toda->y solve failed" };

  const yEntry = clamp(todaYSolve.y, PANEL_1.y, PANEL_1.y + PANEL_1.h);

  // Centre connector
  const centre = solveSurfaceConnector({ yEntry, surface });
  if (!centre.hit)
    return { ok: false as const, reason: "surface connector failed" };

  const ySlope = centre.hit.y;

  // Panel 2: slope -> xDrop
  const slopeSolve = xFromSlopeAtY(slopePercent, ySlope);
  if (slopeSolve.x == null)
    return { ok: false as const, reason: "slope solve failed" };
  const xDrop = slopeSolve.x;

  // Panel 4: wind -> yA
  const windSolve = yFromWindAtX(windKnots, xDrop);
  if (windSolve.y == null)
    return { ok: false as const, reason: "wind solve failed" };

  const aWeight = weightFromY(windSolve.y);

  return {
    ok: true as const,
    xEntry,
    yEntry,
    centre,
    ySlope,
    xDrop,
    yA: windSolve.y,
    aWeight,
  };
}

// ============================
// UI helpers
// ============================

const SURFACE_OPTIONS: Array<{ key: SurfaceKey; label: string }> = [
  { key: "longWet", label: "Long wet grass" },
  { key: "longDryOrShortWet", label: "Long dry grass / Short wet grass" },
  { key: "refShortDry", label: "Reference: short dry grass" },
];

function fmtKg(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${Math.round(x)} kg`;
}

function buildPathD(points: Pt[]) {
  if (!points.length) return "";
  return points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
    )
    .join(" ");
}

function shallowEqualInputs(a: Inputs, b: Inputs) {
  return (
    a.pressureHeightFt === b.pressureHeightFt &&
    a.shadeTempC === b.shadeTempC &&
    a.todaM === b.todaM &&
    a.windKnots === b.windKnots &&
    a.slopePercent === b.slopePercent &&
    a.surface === b.surface
  );
}

const NUMERIC_RANGES: Record<NumericKey, { lo: number; hi: number }> = {
  pressureHeightFt: { lo: 0, hi: 8000 },
  shadeTempC: { lo: -10, hi: 40 },
  todaM: { lo: 400, hi: 1500 },
  windKnots: { lo: -5, hi: 20 },
  slopePercent: { lo: -4, hi: 2 },
};

function coerceWholeInRange<K extends NumericKey>(key: K, value: number) {
  const { lo, hi } = NUMERIC_RANGES[key];
  const clamped = clamp(value, lo, hi);
  return roundWhole(clamped);
}

function computeFinalLimit(vars: Inputs) {
  // Compute B first (density intersection) → pass its X into A
  const B = solveBWeightLimit({
    pressureHeightFt: vars.pressureHeightFt,
    shadeTempC: vars.shadeTempC,
  });

  const densityX = B.ok ? B.ptIntersect.x : null;

  const A = solveAWeightLimit({
    todaM: vars.todaM,
    surface: vars.surface,
    slopePercent: vars.slopePercent,
    windKnots: vars.windKnots,
    densityX,
  });

  const aVal = A.ok ? A.aWeight : Infinity;
  const bVal = B.ok ? B.bWeight : Infinity;
  const finalLimit = Math.min(WEIGHT_LIMIT, aVal, bVal);

  return {
    A,
    B,
    aVal: A.ok ? A.aWeight : null,
    bVal: B.ok ? B.bWeight : null,
    finalLimit,
  };
}

/**
 * Lock-based auto-solver:
 * - Treat locked fields as fixed.
 * - Treat anchor (lastEdited) as fixed so it never gets overwritten.
 * - Try to adjust remaining unlocked fields to make finalLimit ~= target.
 * - If surface is unlocked and not anchored, we try all surfaces and pick best.
 *
 * NEW: numeric adjustments always end up as whole numbers.
 */
function solveWithLocks(opts: {
  inputs: Inputs;
  locks: Locks;
  targetWeightKg: number;
  anchor: VarKey | null;
}) {
  const { inputs, locks, targetWeightKg, anchor } = opts;

  const fixed = new Set<VarKey>();
  (Object.keys(locks) as VarKey[]).forEach((k) => {
    if (locks[k]) fixed.add(k);
  });
  if (anchor && !fixed.has(anchor)) fixed.add(anchor);

  const numericOrder: NumericKey[] = [
    "todaM",
    "windKnots",
    "slopePercent",
    "pressureHeightFt",
    "shadeTempC",
  ];

  function solveNumerics(base: Inputs) {
    let cur = { ...base };

    const tolKg = 0.75;
    const passes = 3;

    for (let pass = 0; pass < passes; pass++) {
      for (const key of numericOrder) {
        if (fixed.has(key)) continue;

        const { lo, hi } = NUMERIC_RANGES[key];

        // Continuous objective (for bisection)
        const fCont = (x: number) => {
          const v = { ...cur, [key]: x } as Inputs;
          return computeFinalLimit(v).finalLimit - targetWeightKg;
        };

        const curErr = fCont((cur as any)[key]);
        if (Math.abs(curErr) <= tolKg) continue;

        const sol = solveBisection({ f: fCont, lo, hi, tol: tolKg });

        let xBest = sol.x;
        if (!sol.bracketed) {
          const elo = Math.abs(fCont(lo));
          const ehi = Math.abs(fCont(hi));
          xBest = elo <= ehi ? lo : hi;
        }

        // NEW: convert to whole-number candidates and pick best by error.
        const curVal = (cur as any)[key] as number;
        const baseInt = roundWhole(xBest);

        const candidates = new Set<number>();
        candidates.add(coerceWholeInRange(key, curVal));
        candidates.add(coerceWholeInRange(key, baseInt));

        for (let d = -3; d <= 3; d++) {
          candidates.add(coerceWholeInRange(key, baseInt + d));
        }
        candidates.add(coerceWholeInRange(key, lo));
        candidates.add(coerceWholeInRange(key, hi));

        let bestCand = coerceWholeInRange(key, baseInt);
        let bestErr = Infinity;
        let bestDelta = Infinity;

        for (const cand of candidates) {
          const v = { ...cur, [key]: cand } as Inputs;
          const err = Math.abs(computeFinalLimit(v).finalLimit - targetWeightKg);
          const delta = Math.abs(cand - curVal);

          if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) < 1e-9 && delta < bestDelta)) {
            bestErr = err;
            bestDelta = delta;
            bestCand = cand;
          }
        }

        cur = { ...cur, [key]: bestCand } as Inputs;
      }
    }

    // Final pass: guarantee all numerics are whole numbers in-range
    cur = {
      ...cur,
      pressureHeightFt: coerceWholeInRange("pressureHeightFt", cur.pressureHeightFt),
      shadeTempC: coerceWholeInRange("shadeTempC", cur.shadeTempC),
      todaM: coerceWholeInRange("todaM", cur.todaM),
      windKnots: coerceWholeInRange("windKnots", cur.windKnots),
      slopePercent: coerceWholeInRange("slopePercent", cur.slopePercent),
    };

    return cur;
  }

  const surfaceCandidates: SurfaceKey[] = fixed.has("surface")
    ? [inputs.surface]
    : SURFACE_OPTIONS.map((s) => s.key);

  let best: { solved: Inputs; score: number } | null = null;

  for (const s of surfaceCandidates) {
    let candidate: Inputs = { ...inputs, surface: s };

    candidate = solveNumerics(candidate);

    const { finalLimit } = computeFinalLimit(candidate);
    const err = Math.abs(finalLimit - targetWeightKg);

    const switchPenalty = s === inputs.surface ? 0 : 0.25;
    const score = err + switchPenalty;

    if (!best || score < best.score) {
      best = { solved: candidate, score };
    }
  }

  return best?.solved ?? inputs;
}

export default function Figure3Page() {
  const [inputs, setInputs] = useState<Inputs>({
    pressureHeightFt: 4600,
    shadeTempC: 10,
    todaM: 900,
    windKnots: 0,
    slopePercent: 2,
    surface: "longDryOrShortWet",
  });

  const [locks, setLocks] = useState<Locks>({
    pressureHeightFt: false,
    shadeTempC: false,
    todaM: false,
    windKnots: false,
    slopePercent: false,
    surface: false,
  });

  const [targetWeightKg, setTargetWeightKg] = useState(1000);
  const [lastEdited, setLastEdited] = useState<VarKey | null>(null);

  const toggleLock = (k: VarKey) => {
    setLocks((prev) => ({ ...prev, [k]: !prev[k] }));
    setLastEdited(null);
  };

  const effectiveInputs = useMemo(() => {
    // Ensure starting point is whole-number clean before solving
    const base: Inputs = {
      ...inputs,
      pressureHeightFt: coerceWholeInRange("pressureHeightFt", inputs.pressureHeightFt),
      shadeTempC: coerceWholeInRange("shadeTempC", inputs.shadeTempC),
      todaM: coerceWholeInRange("todaM", inputs.todaM),
      windKnots: coerceWholeInRange("windKnots", inputs.windKnots),
      slopePercent: coerceWholeInRange("slopePercent", inputs.slopePercent),
    };

    return solveWithLocks({
      inputs: base,
      locks,
      targetWeightKg,
      anchor: lastEdited,
    });
  }, [inputs, locks, targetWeightKg, lastEdited]);

  useEffect(() => {
    setInputs((prev) => {
      let next = { ...prev };

      const maybeSet = <K extends keyof Inputs>(key: K, value: Inputs[K]) => {
        const varKey = key as unknown as VarKey;
        if (locks[varKey]) return;
        if (lastEdited === varKey) return;

        if (typeof value === "number") {
          const pv = prev[key] as unknown as number;
          const nvRaw = value as unknown as number;

          // Force whole numbers for all numeric fields
          const nv =
            (key as any) === "surface"
              ? (nvRaw as any)
              : coerceWholeInRange(key as unknown as NumericKey, nvRaw);

          if (Number.isFinite(nv) && pv !== nv) {
            (next as any)[key] = nv;
          }
        } else {
          if (prev[key] !== value) {
            (next as any)[key] = value;
          }
        }
      };

      maybeSet("pressureHeightFt", effectiveInputs.pressureHeightFt);
      maybeSet("shadeTempC", effectiveInputs.shadeTempC);
      maybeSet("todaM", effectiveInputs.todaM);
      maybeSet("windKnots", effectiveInputs.windKnots);
      maybeSet("slopePercent", effectiveInputs.slopePercent);
      maybeSet("surface", effectiveInputs.surface);

      return shallowEqualInputs(prev, next) ? prev : next;
    });
  }, [effectiveInputs, locks, lastEdited]);

  const computed = useMemo(() => {
    const { A, B, aVal, bVal, finalLimit } = computeFinalLimit(effectiveInputs);

    const overBy = targetWeightKg > finalLimit ? targetWeightKg - finalLimit : 0;

    const aPathPts: Pt[] | null =
      A.ok && A.centre.hit
        ? [
            { x: A.xEntry, y: A.yEntry }, // Panel 1 entry aligned to Panel 3 x
            { x: X_REF, y: A.yEntry },
            { x: A.centre.hit.x, y: A.centre.hit.y },
            { x: PANEL_2.x, y: A.centre.hit.y },
            { x: A.xDrop, y: A.ySlope },
            { x: A.xDrop, y: A.yA },
            { x: WT_1100.x, y: A.yA },
          ]
        : null;

    const bPathPts: Pt[] | null =
      B.ok
        ? [
            { x: B.ptPH.x, y: B.ptPH.y },
            { x: B.ptIntersect.x, y: B.ptIntersect.y },
            { x: B.ptIntersect.x, y: B.yStop },
            { x: WT_1100.x, y: B.yStop },
          ]
        : null;

    // Optional: construction line from Panel 3 density intersection X up to Panel 1 entry Y
    const bBranchToPanel1: Pt[] | null =
      A.ok && B.ok
        ? [
            { x: B.ptIntersect.x, y: B.ptIntersect.y },
            { x: B.ptIntersect.x, y: A.yEntry },
          ]
        : null;

    return {
      A,
      B,
      aVal,
      bVal,
      finalLimit,
      overBy,
      aPathPts,
      bPathPts,
      bBranchToPanel1,
    };
  }, [effectiveInputs, targetWeightKg]);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Take-off Weight Calculator
            </h1>
            <p className="text-sm text-slate-600">
              Set your target take-off weight, then lock the values you want to
              keep fixed. Edit any unlocked field and the other unlocked
              variables will auto-adjust.
            </p>
          </div>

          {/* Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
            {/* Inputs */}
            <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Inputs</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Locked fields are fixed. Unlocked fields can auto-adjust to
                  satisfy the target.
                </p>
              </div>

              <div className="mt-4 grid gap-4">
                <div>
                  <label className="text-xs font-medium text-slate-700">
                    Target Take-off Weight (kg)
                  </label>
                  <input
                    type="number"
                    step={1}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                    value={targetWeightKg}
                    onChange={(e) => {
                      setTargetWeightKg(roundWhole(Number(e.target.value)));
                      setLastEdited(null);
                    }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  {/* Pressure height */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        Pressure height (ft)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.pressureHeightFt}
                          onChange={() => toggleLock("pressureHeightFt")}
                        />
                        Lock
                      </label>
                    </div>
                    <input
                      type="number"
                      step={1}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.pressureHeightFt}
                      disabled={locks.pressureHeightFt}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setInputs((prev) => ({
                          ...prev,
                          pressureHeightFt: coerceWholeInRange("pressureHeightFt", v),
                        }));
                        setLastEdited("pressureHeightFt");
                      }}
                    />
                  </div>

                  {/* Shade temp */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        Shade temp (°C)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.shadeTempC}
                          onChange={() => toggleLock("shadeTempC")}
                        />
                        Lock
                      </label>
                    </div>
                    <input
                      type="number"
                      step={1}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.shadeTempC}
                      disabled={locks.shadeTempC}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setInputs((prev) => ({
                          ...prev,
                          shadeTempC: coerceWholeInRange("shadeTempC", v),
                        }));
                        setLastEdited("shadeTempC");
                      }}
                    />
                  </div>

                  {/* TODA */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        TODA (m)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.todaM}
                          onChange={() => toggleLock("todaM")}
                        />
                        Lock
                      </label>
                    </div>
                    <input
                      type="number"
                      step={1}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.todaM}
                      disabled={locks.todaM}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setInputs((prev) => ({
                          ...prev,
                          todaM: coerceWholeInRange("todaM", v),
                        }));
                        setLastEdited("todaM");
                      }}
                    />
                  </div>

                  {/* Wind */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        Wind component (kt)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.windKnots}
                          onChange={() => toggleLock("windKnots")}
                        />
                        Lock
                      </label>
                    </div>
                    <input
                      type="number"
                      step={1}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.windKnots}
                      disabled={locks.windKnots}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setInputs((prev) => ({
                          ...prev,
                          windKnots: coerceWholeInRange("windKnots", v),
                        }));
                        setLastEdited("windKnots");
                      }}
                    />
                  </div>

                  {/* Slope */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        Slope (%)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.slopePercent}
                          onChange={() => toggleLock("slopePercent")}
                        />
                        Lock
                      </label>
                    </div>
                    <input
                      type="number"
                      step={1}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.slopePercent}
                      disabled={locks.slopePercent}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setInputs((prev) => ({
                          ...prev,
                          slopePercent: coerceWholeInRange("slopePercent", v),
                        }));
                        setLastEdited("slopePercent");
                      }}
                    />
                  </div>

                  {/* Surface */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-700">
                        Surface
                      </label>
                      <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                        <input
                          type="checkbox"
                          checked={locks.surface}
                          onChange={() => toggleLock("surface")}
                        />
                        Lock
                      </label>
                    </div>
                    <select
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100"
                      value={inputs.surface}
                      disabled={locks.surface}
                      onChange={(e) => {
                        setInputs((prev) => ({
                          ...prev,
                          surface: e.target.value as SurfaceKey,
                        }));
                        setLastEdited("surface");
                      }}
                    >
                      {SURFACE_OPTIONS.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </section>

            {/* Chart + Results */}
            <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5">
              <div className="flex flex-col gap-4">
                {/* Result strip */}
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 px-4 py-3">
                    <div className="text-xs text-slate-600">Result</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <div className="text-2xl font-semibold text-slate-900">
                        {fmtKg(computed.finalLimit)}
                      </div>
                      {computed.overBy > 0 && (
                        <div className="text-sm text-red-600">
                          Over by {Math.round(computed.overBy)} kg
                        </div>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      A-limit {fmtKg(computed.aVal)} • B-limit{" "}
                      {fmtKg(computed.bVal)} • Max {WEIGHT_LIMIT}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 w-full md:w-auto">
                    <div className="rounded-2xl bg-white ring-1 ring-slate-200 px-4 py-3">
                      <div className="text-xs text-slate-600">A-limit</div>
                      <div className="mt-1 text-lg font-semibold text-slate-900">
                        {fmtKg(computed.aVal)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        runway/surface/slope/wind
                      </div>
                    </div>
                    <div className="rounded-2xl bg-white ring-1 ring-slate-200 px-4 py-3">
                      <div className="text-xs text-slate-600">B-limit</div>
                      <div className="mt-1 text-lg font-semibold text-slate-900">
                        {fmtKg(computed.bVal)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        pressure height/temp
                      </div>
                    </div>
                    <div className="rounded-2xl bg-white ring-1 ring-slate-200 px-4 py-3">
                      <div className="text-xs text-slate-600">Final limit</div>
                      <div className="mt-1 text-lg font-semibold text-slate-900">
                        {fmtKg(computed.finalLimit)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        min(A, B, 1090)
                      </div>
                    </div>
                  </div>
                </div>

                {/* Chart */}
                <div className="relative w-full overflow-hidden rounded-2xl ring-1 ring-slate-200 bg-white">
                  <Image
                    src="/charts/workbook_v3_0a/figure_3v2.png"
                    alt="CASA Workbook Figure 3 - Take-off Weight Chart"
                    width={VIEWBOX_W}
                    height={VIEWBOX_H}
                    className="w-full h-auto block"
                    priority
                  />

                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {/* Optional split branch (dashed red) */}
                    {computed.bBranchToPanel1 && (
                      <path
                        d={buildPathD(computed.bBranchToPanel1)}
                        fill="none"
                        stroke="#dc2626"
                        strokeWidth={3}
                        strokeDasharray="8 6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.65}
                      />
                    )}

                    {/* A path (solid red) */}
                    {computed.aPathPts && (
                      <>
                        <path
                          d={buildPathD(computed.aPathPts)}
                          fill="none"
                          stroke="#dc2626"
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle
                          cx={computed.aPathPts[0].x}
                          cy={computed.aPathPts[0].y}
                          r={5}
                          fill="#dc2626"
                        />
                        <circle
                          cx={computed.aPathPts[computed.aPathPts.length - 2].x}
                          cy={computed.aPathPts[computed.aPathPts.length - 2].y}
                          r={6}
                          fill="#dc2626"
                        />
                      </>
                    )}

                    {/* B path (dashed red) */}
                    {computed.bPathPts && (
                      <>
                        <path
                          d={buildPathD(computed.bPathPts)}
                          fill="none"
                          stroke="#dc2626"
                          strokeWidth={3}
                          strokeDasharray="8 6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity={0.95}
                        />
                        <circle
                          cx={computed.bPathPts[0].x}
                          cy={computed.bPathPts[0].y}
                          r={5}
                          fill="#dc2626"
                        />
                        <circle
                          cx={computed.bPathPts[computed.bPathPts.length - 2].x}
                          cy={computed.bPathPts[computed.bPathPts.length - 2].y}
                          r={6}
                          fill="#dc2626"
                        />
                      </>
                    )}
                  </svg>
                </div>

                <div className="text-xs text-slate-600">
                  Solid red = A-path. Dashed red = B-path (and optional split
                  branch).
                </div>

                {/* Errors (if any) */}
                <div className="text-xs">
                  {!computed.A.ok && (
                    <div className="text-red-600">
                      A-path error: {computed.A.reason}
                    </div>
                  )}
                  {!computed.B.ok && (
                    <div className="text-red-600">
                      B-path error: {computed.B.reason}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
