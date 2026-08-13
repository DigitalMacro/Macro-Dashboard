# MFERM Dashboard — Module Addition: Cross-Asset Regimes
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/routers/cross_asset.py`
- `frontend/app/cross-asset/page.tsx`

**Files to read first:**
- `backend/services/fred_service.py` (shared FRED helper)
- `backend/cache/simple_cache.py`
- An existing module frontend (e.g. `frontend/app/yield-curve/page.tsx`) for chart/card patterns

**Wire into:**
- `backend/main.py`: register cross_asset router
- Sidebar: add "Cross-Asset" nav item → `/cross-asset`, positioned after Global Rates

---

## Purpose

Classify every trading day into one of 8 directional regimes based on whether SPX, UST 10Y, and DXY are moving up or down over a vol-scaled lookback window. Overlay BTC as a fourth signal: its own directional state, its vol-scaled signal line, and its historical performance in each of the 8 macro regimes. Add rolling cross-asset correlation and a market linkage gauge (share of variance explained by the first principal component).

**Design decision:** BTC does NOT expand the regime space to 16. The 8-regime SPX/rates/DXY framework is canonical; 16 regimes over a 2Y window would leave several with too few observations to be meaningful. BTC is an overlay: its direction is shown alongside the current regime, and its per-regime performance stats answer "how does BTC trade in each macro environment."

---

## Data Sources

| Signal | Source | Series/Ticker | Notes |
|---|---|---|---|
| SPX | yfinance | `^GSPC` | fall back to `SPY` if index unavailable |
| UST 10Y | FRED | `DGS10` | already fetched by other modules — shared cache |
| DXY | yfinance | `DX-Y.NYB` | fall back to `UUP` (label honestly as "UUP proxy" in response) |
| BTC | yfinance | `BTC-USD` | trades 7 days/week — see alignment note |

**Alignment note (important):** BTC trades weekends; equities/rates don't. Align everything to the NYSE trading calendar: reindex BTC to the SPX date index (weekend BTC moves collapse into Monday's observation). Never forward-fill SPX onto weekends.

**Lookback:** fetch 3 years of daily data (need 2Y of signals + warmup for vol windows). Cache 4h TTL.

---

## Backend — `backend/routers/cross_asset.py`

**Router prefix:** `/api/cross-asset`

### Signal computation

For each asset, the vol-scaled directional signal:
```python
# Daily changes: pct change for SPX, DXY, BTC; yield change for 10Y
ret = series.pct_change()              # SPX, DXY, BTC
ret_rates = dgs10.diff()               # 10Y in yield points (rates UP = yield rising)

# Vol-scaled signal: cumulative move over lookback, scaled by realized vol
lookback = 20   # sessions
vol_window = 21

signal = ret.rolling(lookback).sum() / ret.rolling(vol_window).std()
```
The signal is unitless (a z-style score). `signal > 0` = UP state, `signal < 0` = DOWN state. For rates, UP means yields RISING.

### Regime classification (8 regimes)

```python
REGIMES = {
    "R1": {"spx": "up",   "rates": "up",   "dxy": "up"},
    "R2": {"spx": "up",   "rates": "up",   "dxy": "down"},
    "R3": {"spx": "up",   "rates": "down", "dxy": "up"},
    "R4": {"spx": "up",   "rates": "down", "dxy": "down"},
    "R5": {"spx": "down", "rates": "up",   "dxy": "up"},
    "R6": {"spx": "down", "rates": "up",   "dxy": "down"},
    "R7": {"spx": "down", "rates": "down", "dxy": "up"},
    "R8": {"spx": "down", "rates": "down", "dxy": "down"},
}

REGIME_COLORS = {
    "R1": "#34d399", "R2": "#10b981",   # SPX up + rates up: greens
    "R3": "#38bdf8", "R4": "#0ea5e9",   # SPX up + rates down: blues
    "R5": "#f87171", "R6": "#fb923c",   # SPX down + rates up: red/orange
    "R7": "#a78bfa", "R8": "#c084fc",   # SPX down + rates down: purples
}
```

Each day gets a regime label from the sign of the three signals. Days where any signal is NaN (warmup) are excluded.

### Regime statistics (2Y window)

Per regime:
- `days`: count of trading days in this regime
- `share`: percent of window
- `avg_run`: average consecutive-day run length
- `btc_avg_daily_ret`: BTC's average daily return (%) on days in this regime
- `btc_hit_rate`: share of days in this regime where BTC was positive
- `spx_avg_daily_ret`: same for SPX (context column)

### Correlation & linkage

- **Rolling pairwise correlations** (20D window, raw daily moves): SPX/rates, SPX/DXY, rates/DXY, and the three BTC pairs (BTC/SPX, BTC/rates, BTC/DXY). 2Y history.
- **Avg abs pairwise correlation** (20D rolling): mean of |corr| across the three core pairs (SPX/rates/DXY only, to match the reference).
- **Market linkage gauge**: rolling 63D PCA on standardized daily moves of SPX, 10Y, DXY — share of total variance explained by PC1. Rolled daily for 2Y. Include the current value's 2Y percentile.
- **BTC linkage**: same PCA computed on the 4-asset set (SPX, 10Y, DXY, BTC) — current PC1 share and whether adding BTC raises or lowers it (is BTC trading as part of the macro complex or on its own story?).

### Endpoint

**`GET /api/cross-asset/snapshot`**
Query params: `lookback` (int sessions, default 20) · `vol_window` (int, default 21)

```json
{
  "as_of": "2026-07-16",
  "current": {
    "regime": "R5",
    "regime_label": "SPX DN · RATES UP · DXY UP",
    "days_in_regime": 1,
    "signals": { "spx": -0.44, "rates": 2.91, "dxy": 0.35, "btc": -1.12 },
    "btc_state": "down",
    "btc_aligned_with_spx": true,
    "levels": {
      "spx": 7479, "spx_1m_pct": 1.6,
      "ust10y": 4.55, "ust10y_1m_bp": 12,
      "dxy": 100.7, "dxy_1m_pct": 0.1,
      "btc": 118250, "btc_1m_pct": -3.2
    }
  },
  "signal_series": [
    { "date": "2024-08-01", "spx": 1.2, "rates": -0.8, "dxy": 0.3, "btc": 2.1, "regime": "R2" }
  ],
  "correlations": {
    "series": [
      { "date": "2024-08-01", "spx_rates": -0.15, "spx_dxy": -0.45, "rates_dxy": 0.24,
        "btc_spx": 0.62, "btc_rates": -0.08, "btc_dxy": -0.31, "avg_abs_core": 0.28 }
    ],
    "current": { "spx_rates": -0.15, "spx_dxy": -0.45, "rates_dxy": 0.24,
                 "btc_spx": 0.62, "btc_rates": -0.08, "btc_dxy": -0.31 }
  },
  "linkage": {
    "series": [ { "date": "2024-10-01", "pc1_share": 0.55 } ],
    "current_pc1_share": 0.771,
    "percentile_2y": 77,
    "with_btc_pc1_share": 0.68,
    "btc_in_complex": true
  },
  "regime_stats": [
    { "regime": "R1", "label": "SPX UP · RATES UP · DXY UP", "days": 104, "share": 20.6,
      "avg_run": 4.7, "btc_avg_daily_ret": 0.21, "btc_hit_rate": 0.56, "spx_avg_daily_ret": 0.09 }
  ],
  "most_frequent_2y": { "regime": "R4", "share": 22.6 },
  "regimes": { "R1": { "label": "SPX UP · RATES UP · DXY UP", "color": "#34d399" } }
}
```

---

## Frontend — `frontend/app/cross-asset/page.tsx`

Reference: Capital Flows "Regime Timeline" and "Market Linkage & Correlations" pages.

### Header
- Section label: `CROSS-ASSET REGIMES`
- Title: "Cross-Asset Regimes"
- Subtitle: "SPX, UST 10Y and DXY vol-scaled signals classified into 8 directional regimes · BTC overlay"
- LIVE badge · Refresh

### KPI strip (5 cards)
1. **SPX** — level + 1M % change
2. **UST 10Y** — level + 1M bp change
3. **DXY** — level + 1M % change
4. **BTC** — level + 1M % change (the addition vs the reference)
5. **Current Regime** — `R5` large + `SPX DN · RATES UP · DXY UP` sub-label, card border in the regime color. Below: a small BTC state chip — `BTC DN · ALIGNED W/ SPX` or `BTC UP · DIVERGENT`

### Vol-Scaled Directional Signals chart
- Section title: `VOL-SCALED DIRECTIONAL SIGNALS`
- Subtitle: `US · VOL-SCALED · 20D LOOKBACK · 21D VOL · 2Y · DAILY`
- Recharts LineChart, 2Y daily:
  - SPX signal: green (`#34d399`)
  - UST 10Y signal: blue (`#38bdf8`)
  - DXY signal: orange (`#fb923c`)
  - BTC signal: purple (`#c084fc`)
  - ReferenceLine y=0; symmetric y-domain
- **Regime ribbon** directly below the chart, same x-axis width: a thin (16px) horizontal strip where each day is a 1-day-wide colored band in its regime color. Must align horizontally with the chart's plot area.

### Rolling Covariance chart
- Section title: `ROLLING COVARIANCE`
- Subtitle: `AVG ABS PAIRWISE CORRELATION · SPX % / UST 10Y BP / DXY % RAW DAILY MOVES · 20D ROLLING · 2Y`
- Single line: `avg_abs_core`, purple, y-domain [0, 1]

### BTC Correlation panel
- Section title: `BTC · MACRO CORRELATIONS`
- Recharts LineChart, 2Y: three lines — BTC/SPX, BTC/rates, BTC/DXY — ReferenceLine at 0, y-domain [-1, 1]
- Right-side reading card:
  - `BTC/SPX +0.62` · `BTC/RATES -0.08` · `BTC/DXY -0.31`
  - `LINKAGE (3-ASSET): 77.1% · 2Y %ILE 77`
  - `LINKAGE +BTC: 68.0%`
  - Verdict line: `BTC TRADING WITH THE MACRO COMPLEX` if btc_in_complex else `BTC ON ITS OWN STORY`

### Regime Frequency table
- Section title: `REGIME FREQUENCY` · Subtitle: `2Y WINDOW · TRADING DAYS · SHARE · AVG RUN · BTC PERFORMANCE`
- One row per regime R1–R8:
  - Color swatch + `R1 · SPX UP · RATES UP · DXY UP`
  - DAYS · SHARE (with horizontal bar proportional to share) · AVG RUN
  - `BTC AVG` (avg daily ret %, green/red) · `BTC HIT` (hit rate %)
  - Current regime row highlighted: `‹ NOW` marker + subtle background tint in regime color
- This table is the BTC payoff: which macro regimes BTC historically likes and which it hates

### WHAT THIS IS / CURRENT READING panels
Standard card style:
- WHAT THIS IS: "Every day is sorted into one of 8 regimes by whether SPX, UST 10Y and DXY are moving up or down over the lookback window, with each move scaled by its own volatility so the assets are comparable. BTC is overlaid as a fourth signal: its direction, its correlation to each leg, and its average performance inside each regime — showing whether crypto is trading as a macro asset or on its own story."
- CURRENT READING: current regime + days in · signals for all four assets · most frequent regime 2Y · BTC state and alignment

---

## Page Layout Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Header · LIVE · Refresh                                     │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ SPX      │ UST 10Y  │ DXY      │ BTC      │ CURRENT REGIME  │
├──────────┴──────────┴──────────┴──────────┴───┬─────────────┤
│ VOL-SCALED DIRECTIONAL SIGNALS (4 lines, 2Y)  │ WHAT THIS IS│
│ [regime ribbon strip]                         │ CURRENT     │
├───────────────────────────────────────────────┤ READING     │
│ ROLLING COVARIANCE (avg abs corr, 2Y)         │             │
├───────────────────────────────────┬───────────┴─────────────┤
│ BTC · MACRO CORRELATIONS (3 lines)│ BTC reading card        │
├───────────────────────────────────┴─────────────────────────┤
│ REGIME FREQUENCY table (R1–R8 + BTC perf columns)           │
└─────────────────────────────────────────────────────────────┘
```

---

## Build Order

1. **Read** shared services and an existing frontend module for patterns
2. Build signal computation + regime classification in `cross_asset.py`; verify signals are sane (current signal magnitudes reasonable, regime matches recent market direction)
3. Add correlation series and PCA linkage (numpy-only implementation preferred; check requirements.txt before adding sklearn)
4. Add regime stats table computation with BTC per-regime performance
5. Register router; `curl` the endpoint and sanity-check: shares sum to ~100%, all 8 regimes present, BTC stats populated
6. Build frontend; the regime ribbon must align with the signal chart's plot area — test at multiple viewport widths
7. Sidebar: Cross-Asset after Global Rates
8. `npm run build` — zero type errors

## Notes for Claude Code

- BTC weekend alignment: reindex BTC to SPX's date index BEFORE computing returns, so Monday's BTC return spans the weekend — do not drop it
- DGS10 has occasional NaN (holidays where NYSE trades) — forward-fill DGS10 onto the SPX calendar, max 3-day fill
- Vol-scaled signal denominators: guard against zero/near-zero vol (`std.replace(0, np.nan)`)
- PCA: standardize each asset's daily moves (z-score within the 63D window) before computing — otherwise SPX % and 10Y bp scales distort loadings
- The regime ribbon is the visual signature of this page — if a plain flex-div row proves hard to align with Recharts' plot area, render the ribbon inside the chart as ReferenceArea bands at the bottom 5% of the y-domain
- yfinance `^GSPC` and `DX-Y.NYB`: verify both return data on first build; fall back to SPY/UUP with honest labeling in the response (`"dxy_source": "UUP proxy"`)
- yfinance MultiIndex columns: use the `.squeeze("columns")` pattern established in regime.py
