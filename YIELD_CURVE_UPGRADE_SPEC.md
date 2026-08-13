# MFERM Dashboard — Module Upgrade: Yield Curve Regime Decomposition
**This modifies the existing Yield Curve module. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to modify:**
- `backend/routers/yield_curve.py` (extend existing)
- `frontend/app/yield-curve/page.tsx` (extend existing)

**Files to read first (do not modify unless refactoring shared helpers):**
- `backend/routers/rate_decomp.py` (reuse FRED fetch + decomposition patterns)
- `backend/routers/regime.py` (existing patterns)
- `backend/main.py` (router registration — no changes needed, already wired)

**No new files. No sidebar changes. This is a pure upgrade of existing module.**

---

## Purpose

The existing Yield Curve module classifies regimes (bull/bear steepener/flattener/twist) using nominal yields only. This upgrade adds the same regime classification on the real yield curve and the inflation swap curve independently, so you can see which leg is actually driving the curve shape. This matches the Capital Flows approach: one regime label can hide disagreement between the real and inflation legs.

---

## What Changes vs What Stays

**Stays unchanged:**
- All existing endpoint query params (method, window)
- Existing nominal yield time series chart
- Existing nominal spread chart
- Existing regime classification logic
- Existing asset heatmap
- KPI strip structure (but adding cards)

**New additions:**
- Real yield (TIPS) and inflation swap 2s10s spreads tracked alongside nominal
- Independent regime classification on each of the three curves
- Three-curve regime status in the KPI area
- Real and inflation spread charts below the existing nominal spread chart
- Regime ribbon visualization on each spread chart
- Regime agreement/divergence indicator

---

## Additional Data Sources

Reuse the FRED fetch helper from `rate_decomp.py` or `services/fred_service.py` (whichever exists after the Rate Decomp build). All new series:

| Series | Description | Used for |
|---|---|---|
| `DFII2` | 2Y TIPS Real Yield | Real 2s10s = DFII10 - DFII2 |
| `DFII10` | 10Y TIPS Real Yield | Real 2s10s = DFII10 - DFII2 |

Inflation swap yields are derived: `inf_swap_2y = DGS2 - DFII2`, `inf_swap_10y = DGS10 - DFII10`
Inflation 2s10s = `inf_swap_10y - inf_swap_2y`

`DGS2` and `DGS10` are already fetched by the existing module.

---

## Backend Changes — `backend/routers/yield_curve.py`

### New compute logic (add to existing module)

**Three parallel 2s10s spreads:**
```python
nominal_2s10s = DGS10 - DGS2          # already exists
real_2s10s = DFII10 - DFII2            # new
inflation_2s10s = inf_swap_10y - inf_swap_2y  # new (derived)

# Identity check: nominal_2s10s = real_2s10s + inflation_2s10s
# Force: inflation_2s10s = nominal_2s10s - real_2s10s
```

**Independent regime classification on each curve:**
Apply the existing `classify_yield_curve()` function to each curve's 2Y and 10Y independently:

```python
# Nominal (existing)
nominal_regime = classify_yield_curve(d_dgs2, d_dgs10, threshold)

# Real
d_dfii2 = change in DFII2 over window
d_dfii10 = change in DFII10 over window
real_regime = classify_yield_curve(d_dfii2, d_dfii10, threshold)

# Inflation swap
d_inf2 = change in inf_swap_2y over window
d_inf10 = change in inf_swap_10y over window
inflation_regime = classify_yield_curve(d_inf2, d_inf10, threshold)
```

Same classification function, same threshold, same regime labels — just applied to different yield inputs.

**Days in regime — track for each curve independently:**
Each curve has its own `days_in_regime` counter.

### Updated endpoint response

Extend the existing `GET /api/yield-curve/snapshot` response. Do NOT remove any existing fields — only add new ones. Frontend code that reads existing fields must not break.

New fields to add at the top level:
```json
{
  "...existing fields stay...",

  "real_2y": 1.87,
  "real_10y": 2.17,
  "real_spread_bps": 30,
  "real_spread_change_bps": -5,
  "real_regime": "bear_steepener",
  "real_days_in_regime": 3,
  "real_d2y": 0.12,
  "real_d10y": 0.20,

  "inflation_2y": 2.30,
  "inflation_10y": 2.38,
  "inflation_spread_bps": 8,
  "inflation_spread_change_bps": 12,
  "inflation_regime": "neutral",
  "inflation_days_in_regime": 1,
  "inflation_d2y": -0.11,
  "inflation_d10y": 0.01,

  "regime_agreement": false,
  "divergent_curves": ["inflation"],

  "real_time_series": [
    { "date": "2024-01-01", "yield_2y": 1.75, "yield_10y": 2.06, "spread": 31, "regime": "bear_steepener" }
  ],
  "inflation_time_series": [
    { "date": "2024-01-01", "yield_2y": 2.41, "yield_10y": 2.37, "spread": -4, "regime": "bull_flattener" }
  ]
}
```

**`regime_agreement`**: `true` if all three curves (nominal, real, inflation) are in the same regime family (steepener/flattener/twist), `false` if any disagree.

**`divergent_curves`**: list of curve names that disagree with the nominal regime. Empty if all agree.

---

## Frontend Changes — `frontend/app/yield-curve/page.tsx`

### KPI strip — expand from 6 to 8 cards

Keep existing 6 cards, add 2 new ones at the end:

| # | Label | Value | Existing? |
|---|---|---|---|
| 1 | Current Regime (Nominal) | label in regime color | ✅ existing — add "(Nominal)" suffix to label |
| 2 | 2Y Yield | 4.21% | ✅ existing |
| 3 | 10Y Yield | 4.68% | ✅ existing |
| 4 | Spread | +47 bps | ✅ existing |
| 5 | Spread Δ | +12 bps | ✅ existing |
| 6 | Days in Regime | 9 | ✅ existing |
| 7 | Real Regime | label in regime color | 🔨 NEW |
| 8 | Inflation Regime | label in regime color | 🔨 NEW |

If the viewport is too wide for 8, use a 4+4 two-row layout rather than shrinking cards.

### Three-curve regime summary banner

New component, placed below the KPI strip, above the regime quadrant grid:

```
┌──────────────────────────────────────────────────────────────────────┐
│  NOM  BEAR STEEPENER 2D     REAL  BEAR STEEPENER 3D     INF  NEUTRAL 1D  │
│  ■ ALIGNED / ▲ 1 DIVERGENT                                          │
└──────────────────────────────────────────────────────────────────────┘
```

- Three inline regime chips, each showing: curve label (NOM/REAL/INF) + regime name in regime color + days in regime
- Below: alignment indicator
  - If all three agree: `■ ALL ALIGNED` in green
  - If 1–2 diverge: `▲ N DIVERGENT` in amber, with the divergent curve names listed
- Style: `bg-neutral-900/60 border border-neutral-800 rounded-lg p-4`

### Existing regime quadrant grid — keep as-is

No changes to the 2×3 quadrant grid. It continues to show the NOMINAL regime classification. The three-curve banner above it provides the decomposed view.

### Existing yield chart and spread chart — keep as-is

These continue to show nominal 2Y vs 10Y and nominal 2s10s spread.

### NEW: Real 2s10s Spread chart (add below existing spread chart)

- Section title: `REAL 2S10S SPREAD` (10px mono)
- Subtitle: `TIPS REAL YIELD · 10Y MINUS 2Y · BP · REGIME SHADING`
- Recharts AreaChart:
  - Single area: real 2s10s spread in bps
  - Fill: blue (`#38bdf8`) above zero with 20% opacity, red below zero
  - ReferenceLine at y=0
  - Background: ReferenceArea bands colored by REAL regime (same regime shading pattern as existing nominal chart)
  - Tooltip: date + real spread bps + real regime label
- Right side mini-panel:
  - `REAL 2S10S +30bp`
  - `1M -5bp`
  - `REGIME: BEAR STEEPENER · 3D`

### NEW: Inflation 2s10s Spread chart (add below real spread chart)

- Section title: `INFLATION SWAP 2S10S SPREAD`
- Subtitle: `BREAKEVEN · 10Y MINUS 2Y · BP · REGIME SHADING`
- Same layout as real spread chart but:
  - Fill color: orange (`#fb923c`) above zero, red below zero
  - Background: regime shading by INFLATION regime
  - Tooltip: date + inflation spread bps + inflation regime label
- Right side mini-panel:
  - `INF 2S10S +8bp`
  - `1M +12bp`
  - `REGIME: NEUTRAL · 1D`

### Color consistency

- Nominal yields/spreads: white (`#F0F0F0`) — existing, no change
- Real yields/spreads: blue (`#38bdf8`) — matches Rate Decomp module
- Inflation yields/spreads: orange (`#fb923c`) — matches Rate Decomp module
- Regime shading colors: unchanged from existing module (same regime color palette)

---

## Updated Page Layout (top to bottom)

```
┌─────────────────────────────────────────────────────────────┐
│ Header: Yield Curve Regime (unchanged)                      │
│ LIVE badge · Refresh · Method/Window controls               │
├─────────────────────────────────────────────────────────────┤
│ KPI Strip: 8 cards (existing 6 + Real Regime + Inf Regime)  │
├─────────────────────────────────────────────────────────────┤
│ Three-Curve Regime Banner: NOM / REAL / INF + alignment     │  ← NEW
├─────────────────────────────────────────────────────────────┤
│ Inversion Alert Banner (conditional, existing)              │
├───────────────────────────────────┬──────────────────────────┤
│ Regime Quadrant Grid 2×3         │ (existing, unchanged)    │
│ (nominal classification)         │                          │
├───────────────────────────────────┴──────────────────────────┤
│ 2Y vs 10Y Nominal Yield Chart (existing, unchanged)         │
├─────────────────────────────────────────────────────────────┤
│ Nominal 2s10s Spread Chart (existing, unchanged)            │
├──────────────────────────────────────────────────┬──────────┤
│ Real 2s10s Spread Chart                          │ mini     │  ← NEW
│ blue fill, regime shading                        │ panel    │
├──────────────────────────────────────────────────┼──────────┤
│ Inflation 2s10s Spread Chart                     │ mini     │  ← NEW
│ orange fill, regime shading                      │ panel    │
├──────────────────────────────────────────────────┴──────────┤
│ Asset Heatmap Table (existing, unchanged)                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

1. **Read** `backend/routers/yield_curve.py` fully before making any changes
2. **Read** `backend/routers/rate_decomp.py` (or `services/fred_service.py`) to understand the shared FRED fetch pattern — import and reuse
3. Add DFII2 and DFII10 fetches to the yield curve endpoint (parallel with existing DGS2/DGS10 fetches via `asyncio.gather()`)
4. Compute real and inflation 2s10s spreads — force identity: `inflation = nominal - real`
5. Run existing `classify_yield_curve()` on real and inflation inputs independently
6. Build real and inflation time series in the same format as existing `time_series` field
7. Add all new fields to the response WITHOUT removing any existing fields
8. **Read** `frontend/app/yield-curve/page.tsx` fully before making any changes
9. Extend the KPI strip from 6 to 8 cards — do not restructure existing cards
10. Add the three-curve regime banner component
11. Add the real and inflation spread charts below the existing charts
12. Confirm all three spread charts use consistent regime shading patterns
13. `npm run build` — zero type errors
14. Verify existing nominal-only functionality is completely unchanged

## Critical: Do Not Break Existing Functionality

This is a modification, not a rewrite. Every existing chart, KPI, endpoint field, and user interaction must work identically after this change. The approach is purely additive:
- New FRED series fetched alongside existing ones
- New fields added to the response alongside existing ones
- New UI components added below existing ones
- Existing components untouched except the KPI strip (which gains 2 cards at the end) and the regime label (which gains a "(Nominal)" suffix)

Test by confirming the page loads and all existing elements render before verifying the new additions.
