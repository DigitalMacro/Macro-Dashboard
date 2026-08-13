# MFERM Dashboard — Module Addition: Rate Decomposition
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/routers/rate_decomp.py`
- `frontend/app/rate-decomp/page.tsx`

**Wire into:**
- `backend/main.py`: register rate_decomp router
- Sidebar: add "Rate Decomp" nav item → `/rate-decomp`, positioned after STIR, before Yield Curve

---

## Purpose

Decompose every basis point of nominal yield movement into its real yield and inflation expectations components. This is an exact identity — nominal = real + inflation swap — not a model fit. The module answers: when the 10Y moves 12bps, how much was real rates and how much was inflation repricing? This is the foundation that the Yield Curve regime module and FX module build on.

---

## Data Sources — All FRED, All Free

**Nominal yields (daily):**
| Tenor | FRED Series | Description |
|---|---|---|
| 2Y | `DGS2` | 2-Year Treasury Constant Maturity |
| 5Y | `DGS5` | 5-Year Treasury Constant Maturity |
| 10Y | `DGS10` | 10-Year Treasury Constant Maturity |
| 30Y | `DGS30` | 30-Year Treasury Constant Maturity |

**TIPS real yields (daily):**
| Tenor | FRED Series | Description |
|---|---|---|
| 2Y | `DFII2` | 2-Year Treasury Inflation-Indexed Constant Maturity |
| 5Y | `DFII5` | 5-Year Treasury Inflation-Indexed Constant Maturity |
| 10Y | `DFII10` | 10-Year Treasury Inflation-Indexed Constant Maturity |
| 30Y | `DFII30` | 30-Year Treasury Inflation-Indexed Constant Maturity |

**Inflation swap (derived — not fetched):**
`inflation_swap[tenor] = nominal[tenor] - real[tenor]`

This is the TIPS breakeven rate. It's not literally an inflation swap (those trade OTC), but it's the standard free-data proxy and what Capital Flows labels "inflation swap" on their charts. For the 2Y: `DGS2 - DFII2`, etc.

**No 1Y tenor.** FRED doesn't publish a 1Y TIPS yield. Skip 1Y for now — the 2Y is the policy-sensitive tenor that matters. Can be added later via Cleveland Fed interpolation (`EXPINF1YR`).

**Lookback:** fetch 2 years of daily data for all 8 series. Cache with 4-hour TTL (same as existing factor data).

---

## Backend — `backend/routers/rate_decomp.py`

**Router prefix:** `/api/rate-decomp`

### Computation Logic

**1. Curve Complex snapshot**
For each tenor (2Y, 5Y, 10Y, 30Y):
- `nominal`: latest value from FRED
- `real`: latest TIPS yield from FRED
- `inflation_swap`: `nominal - real`
- `nominal_1m_chg`: change vs 21 sessions ago (bps)
- `real_1m_chg`: change vs 21 sessions ago (bps)
- `inflation_1m_chg`: change vs 21 sessions ago (bps)
- `driver_1m`: whichever of real/inflation has the larger absolute 1M change, expressed as a percentage (e.g. "REAL 93%")

Driver calculation: `driver_pct = abs(real_1m_chg) / (abs(real_1m_chg) + abs(inflation_1m_chg)) * 100` — if both are zero, show "NEUTRAL". The driver label is whichever component has the larger absolute change.

**2. Rolling attribution time series**
For a configurable tenor (default 10Y, user can switch to 2Y):
- Compute rolling N-day change (default N=10, configurable: 5/10/21) in nominal, real, and inflation swap
- Each row: `{ date, nominal_chg, real_chg, inflation_chg }` in bps
- Identity check: `real_chg + inflation_chg == nominal_chg` (within floating point tolerance)
- Return 1 year of daily observations

**3. 2s10s curve decomposition**
The 2s10s spread is itself decomposable:
- `nominal_2s10s = DGS10 - DGS2`
- `real_2s10s = DFII10 - DFII2`
- `inflation_2s10s = inflation_swap_10y - inflation_swap_2y`
- Identity: `nominal_2s10s = real_2s10s + inflation_2s10s`

Rolling 10D change attribution:
- `d_nominal_2s10s = real_leg_contribution + inflation_leg_contribution`
- Same stacked bar logic as the tenor attribution

**4. Curve leg quadrant**
Classify the trailing 21D change in the 2s10s spread by which leg drove it:
- X-axis: real leg 21D change (bps)
- Y-axis: inflation leg 21D change (bps)
- Four quadrants:
  - Top-right: "Both Steepen" (real steepens + inflation steepens)
  - Top-left: "Inflation Steepens · Real Flattens"
  - Bottom-right: "Real Steepens · Inflation Flattens"
  - Bottom-left: "Both Flatten"
- Include trailing 60 sessions of (real_leg_21d, inf_leg_21d) points for the scatter trail
- Current point highlighted with a ring

### Endpoints

**`GET /api/rate-decomp/snapshot`**
Query params: `lookback` (str: "1m"|"3m"|"6m"|"1y"|"2y", default "1y") · `roll_window` (int: 5|10|21, default 10)

Response:
```json
{
  "as_of": "2026-07-16",
  "tenors": {
    "2Y": {
      "nominal": 4.17,
      "real": 1.87,
      "inflation_swap": 2.30,
      "nominal_1m_chg": 1.0,
      "real_1m_chg": 12.0,
      "inflation_1m_chg": -11.0,
      "driver_1m": "REAL",
      "driver_1m_pct": 52.2
    },
    "5Y": { "..." : "..." },
    "10Y": { "..." : "..." },
    "30Y": { "..." : "..." }
  },
  "headline": {
    "tenor": "10Y",
    "nominal": 4.55,
    "real": 2.17,
    "inflation_swap": 2.38,
    "nominal_1m_chg": 12.0,
    "real_1m_chg": 11.0,
    "inflation_1m_chg": 1.0,
    "driver_1m": "REAL",
    "driver_1m_pct": 91.7
  },
  "curve_complex": {
    "nominal_today": [4.17, 4.28, 4.55, 5.07],
    "nominal_1m_ago": [4.16, 4.21, 4.43, 4.88],
    "real_today": [1.87, 1.88, 2.17, 2.75],
    "real_1m_ago": [1.75, 1.82, 2.06, 2.56],
    "inflation_today": [2.30, 2.40, 2.38, 2.32],
    "inflation_1m_ago": [2.41, 2.40, 2.37, 2.32],
    "tenors": ["2Y", "5Y", "10Y", "30Y"]
  },
  "attribution_2y": [
    { "date": "2025-07-17", "nominal_chg": 5.2, "real_chg": 8.1, "inflation_chg": -2.9 }
  ],
  "attribution_10y": [
    { "date": "2025-07-17", "nominal_chg": 3.1, "real_chg": 4.5, "inflation_chg": -1.4 }
  ],
  "curve_decomp_2s10s": {
    "nominal_spread": 38.0,
    "real_spread": 30.0,
    "inflation_spread": 8.0,
    "nominal_1m_chg": 10.0,
    "real_leg_1m_chg": -1.0,
    "inflation_leg_1m_chg": 12.0,
    "driver": "INFLATION",
    "driver_pct": 92.3,
    "time_series": [
      { "date": "2025-07-17", "nominal_chg": 2.1, "real_leg": 0.8, "inflation_leg": 1.3 }
    ]
  },
  "quadrant": {
    "current": {
      "real_leg_21d": -1.0,
      "inf_leg_21d": 12.0,
      "label": "INF STEEPENS · REAL FLATTENS"
    },
    "trail": [
      { "date": "2026-05-01", "real_leg_21d": 3.2, "inf_leg_21d": -1.5 }
    ]
  }
}
```

---

## Frontend — `frontend/app/rate-decomp/page.tsx`

Follow the established design system exactly. Reference the Capital Flows "Curve Complex", "2Y Attribution", "10Y Attribution", and "Curve Decomposition Model" pages for layout and information density.

### Header row
- Section label: `RATE DECOMPOSITION` (10px mono, muted)
- Title: "US · Rate Decomposition"
- Subtitle: "Nominal = real + inflation swap · an exact identity, not a model fit"
- LIVE badge
- Refresh button

### KPI strip (4 cards)
1. **10Y Nominal** — e.g. `4.55%` with `1M +12bp` sub-label
2. **10Y Real** — e.g. `2.17%` with `1M +11bp`
3. **10Y Inflation Swap** — e.g. `2.38%` with `1M +1bp`
4. **10Y Driver · 1M** — e.g. `REAL 93% OF MOVE` — color the word REAL in blue (`#38bdf8`) and INFLATION in orange (`#fb923c`) depending on which is the driver

### Controls row
- Roll window toggle: `5D` | `10D` | `21D` (default 10D)
- Lookback: `3M` | `6M` | `1Y` | `2Y` (default 1Y)

### Curve Complex section (3-column layout)
Three mini curve charts side by side, each showing today vs 1M ago:

**Column 1 — Nominal**
- Title: `NOMINAL` (10px mono uppercase)
- Subtitle: `TODAY 1M AGO`
- Below title: 4 inline KPI chips showing each tenor's level and 1M change:
  `2Y 4.17% +1bp` · `5Y 4.28% +7bp` · `10Y 4.55% +12bp` · `30Y 5.07% +19bp`
  - Change colored green if positive, red if negative
- Recharts LineChart: x-axis = tenor labels (2Y, 5Y, 10Y, 30Y), two lines:
  - Today: solid white line with dots
  - 1M ago: dashed gray line with dots
  - Y-axis: percentage, auto-scaled to data range

**Column 2 — Real**
- Same layout, using TIPS yields
- Line color: blue (`#38bdf8`)

**Column 3 — Inflation Swap**
- Same layout, using derived breakevens
- Line color: orange (`#fb923c`)

### Per-tenor decomposition strip
Below the curve complex, show a horizontal strip of 4 cards (one per tenor):
```
[ 2Y  1M +1bp  ]  [ 5Y  1M +7bp  ]  [ 10Y  1M +12bp  ]  [ 30Y  1M +19bp  ]
[ NOM  REAL INF ]  [ NOM  REAL INF ]  [ NOM   REAL INF ]  [ NOM   REAL INF ]
[ 4.17 1.87 2.30]  [ 4.28 1.88 2.40]  [ 4.55  2.17 2.38]  [ 5.07  2.75 2.32]
[ 1M DRIVER:    ]  [ 1M DRIVER:    ]  [ 1M DRIVER:     ]  [ 1M DRIVER:     ]
[ REAL 53%      ]  [ REAL 97%      ]  [ REAL 93%       ]  [ REAL 98%       ]
```
Each card:
- Header: tenor + 1M nominal change in bps
- Three values in a row: NOM (white), REAL (blue), INF (orange)
- Footer: `1M DRIVER · REAL XX%` or `INF XX%` — driver word colored accordingly

### 2Y Rolling Attribution chart
- Section title: `2Y ROLLING ATTRIBUTION` (10px mono)
- Subtitle: `2Y · ROLLING 10D CHANGE IN BP · REAL + INFLATION CONTRIBUTIONS · 1Y · DAILY`
- Recharts BarChart (stacked):
  - Two bar series stacked: `real_chg` (blue) and `inflation_chg` (orange)
  - One Line overlay: `nominal_chg` (white, thin)
  - X-axis: dates
  - Y-axis: bps, symmetric around zero
  - Legend: `REAL CONTRIBUTION` (blue) · `INFLATION CONTRIBUTION` (orange) · `NOMINAL 10D CHANGE` (white line)
- "WHAT THIS IS" panel (right side or below, muted card):
  > "A nominal treasury yield is the sum of a real yield and an inflation swap, so every basis point of a nominal move can be assigned exactly to one of the two legs. Each bar splits the trailing 10 day nominal change into its real and inflation contributions; the white line is the nominal change the two legs sum to."
- "CURRENT READING" panel:
  > `2Y 1M +1bp nominal`
  > `real +12bp · inf -11bp · REAL 53%`

### 10Y Rolling Attribution chart
- Identical layout to 2Y section, using `attribution_10y` data
- Own "CURRENT READING" panel with 10Y values

### 2s10s Curve Decomposition section
- Section title: `2S10S ROLLING ATTRIBUTION`
- Subtitle: `2S10S = 10Y MINUS 2Y · ROLLING 10D CHANGE IN BP · REAL + INFLATION LEGS · 1Y · DAILY`
- Same stacked BarChart pattern:
  - `real_leg` (blue bars) + `inflation_leg` (orange bars) stacked
  - `nominal_chg` (white line overlay)
- "CURRENT READING" panel:
  > `2s10s 38bp · 1M +10bp`
  > `real leg -1bp 21d`
  > `inflation leg +12bp 21d`
  > `quadrant · INF STEEPENS · REAL FLATTENS`
  > `driver · INFLATION 92%`

### Curve Leg Quadrant (to the right of the 2s10s chart)
- Title: `CURVE LEG QUADRANT`
- Subtitle: `21D LEG CHANGES · TRAIL 60 SESSIONS · RING = TODAY`
- Recharts ScatterChart:
  - X-axis: "REAL LEG 21D BP" — positive = real steepening
  - Y-axis: "INF LEG 21D BP" — positive = inflation steepening
  - ReferenceLine at x=0 and y=0 (neutral axes, gray dashed)
  - Scatter points: 60 trailing observations, small dots, muted color
  - Current point: larger dot with white ring border and colored fill
  - Quadrant labels (10px mono, very muted):
    - Top-left: `INF STEEPENS · REAL FLATTENS`
    - Top-right: `BOTH STEEPEN`
    - Bottom-left: `BOTH FLATTEN`
    - Bottom-right: `REAL STEEPENS · INF FLATTENS`
- This chart should be roughly square aspect ratio

---

## Page Layout Summary (top to bottom)

```
┌─────────────────────────────────────────────────────────────┐
│ Header: RATE DECOMPOSITION · US · Rate Decomposition        │
│ LIVE badge · Refresh · Controls (roll window, lookback)     │
├─────────────────────────────────────────────────────────────┤
│ KPI Strip: 10Y Nominal | 10Y Real | 10Y Inf Swap | Driver  │
├───────────────────┬───────────────────┬─────────────────────┤
│ NOMINAL curve     │ REAL curve        │ INF SWAP curve      │
│ today vs 1M ago   │ today vs 1M ago   │ today vs 1M ago     │
├───────┬───────┬───┴───────┬───────┬───┴─────────┬───────┬───┤
│ 2Y    │ 5Y    │ 10Y       │ 30Y   │             │       │   │
│ decomp│ decomp│ decomp    │ decomp│             │       │   │
├───────┴───────┴───────────┴───────┴─────────────┴───────┴───┤
│ 2Y ROLLING ATTRIBUTION                    │ WHAT THIS IS    │
│ stacked bar: real + inflation             │ explanation     │
│ line overlay: nominal                     │ CURRENT READING │
├───────────────────────────────────────────┤                 │
│ 10Y ROLLING ATTRIBUTION                  │ CURRENT READING │
│ stacked bar: real + inflation             │                 │
│ line overlay: nominal                     │                 │
├─────────────────────────────────┬─────────┴─────────────────┤
│ 2S10S ROLLING ATTRIBUTION      │ CURVE LEG QUADRANT         │
│ stacked bar: real + inf legs   │ scatter: real vs inf 21D   │
│ line overlay: nominal 2s10s    │ trail 60 sessions          │
│ CURRENT READING below          │ current point w/ ring      │
└─────────────────────────────────┴───────────────────────────┘
```

---

## Important Implementation Notes

**The identity must hold exactly.** At every point in every chart: `nominal = real + inflation_swap` and `real_chg + inflation_chg = nominal_chg`. If there's floating point drift, force it: `inflation_chg = nominal_chg - real_chg`. Never let a chart show components that don't sum to the total — this is the entire point of the decomposition.

**Color consistency across the entire dashboard:**
- Nominal / total: white (`#F0F0F0`)
- Real component: blue (`#38bdf8`)
- Inflation component: orange (`#fb923c`)
- These colors MUST be consistent across every chart, KPI, legend, and label in this module. They will also carry forward into the Yield Curve upgrade, FX module, and Global Rates module.

**Chart tooltip format:**
```
Jul 16, 2026
Nominal 10D: +12.3bp
Real:        +11.1bp
Inflation:    +1.2bp
```
Monospace, dark background, same style as existing modules.

**"WHAT THIS IS" and "CURRENT READING" panels:**
These are small cards positioned to the right of the chart (on desktop) or below (if viewport is narrow). Style: `background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; padding: 16px`. Title in amber (`#f59e0b`), 10px mono uppercase. Body in muted gray, 11px.

---

## FRED Series Summary — 8 Series Total

```
DGS2, DGS5, DGS10, DGS30     — nominal yields (daily)
DFII2, DFII5, DFII10, DFII30  — TIPS real yields (daily)
```

All fetched via existing `fetch_fred()` helper in `backend/routers/regime.py`. Import and reuse — do not duplicate the FRED fetching logic. If the helper needs to be moved to a shared module (`backend/services/fred_service.py`), do so and update all existing imports (regime.py, yield_curve.py). Do not change behavior.

**Environment:** uses existing `FRED_API_KEY` from `backend/.env`.

---

## Build Order

1. If `fetch_fred()` is duplicated across routers, refactor into `backend/services/fred_service.py` first — move the function, update imports in `regime.py` and `yield_curve.py`, confirm both existing endpoints still return 200
2. Create `backend/routers/rate_decomp.py` with all compute logic and the `/api/rate-decomp/snapshot` endpoint
3. Register router in `backend/main.py`
4. Confirm `curl http://localhost:8000/api/rate-decomp/snapshot` returns valid JSON with identity checks passing
5. Create `frontend/app/rate-decomp/page.tsx`
6. Update sidebar: reorder tabs to STIR → Rate Decomp → Yield Curve → Regime Matrix → Portfolio → (greyed: Global Rates, Cross-Asset, FX, Equities, Calendar)
7. `npm run build` — zero type errors

## Notes for Claude Code

- Reuse existing FRED fetch + cache patterns — do not install new HTTP clients
- The identity `real + inflation = nominal` must hold at every data point. Force it by deriving inflation as `nominal - real` rather than computing independently
- Stacked BarChart in Recharts: use `<Bar stackId="a">` for real and inflation bars, `<Line>` overlay for nominal total
- ScatterChart for the quadrant: use `<ScatterChart>` with `<ReferenceLine x={0}>` and `<ReferenceLine y={0}>` for the axis cross
- All 8 FRED series should be fetched in parallel using `asyncio.gather()` for performance
- The curve complex mini-charts use categorical x-axis (tenor labels), not time series — use `<LineChart>` with `dataKey` mapped to tenor positions
- Backend should start from `backend/` directory: `.venv/bin/uvicorn main:app --reload --port 8000`
