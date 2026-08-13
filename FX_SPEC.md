# MFERM Dashboard — Module Addition: FX Rate Differentials
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/routers/fx.py`
- `frontend/app/fx/page.tsx`

**Files to read first:**
- `backend/services/global_rates_service.py` — the market adapters already fetch DE/UK/JP 2Y and 10Y history; REUSE these, do not duplicate fetching
- `backend/services/fred_service.py` — US yields + TIPS
- `backend/cache/simple_cache.py`

**Wire into:**
- `backend/main.py`: register fx router
- Sidebar: add "FX" nav item → `/fx`, positioned after Cross-Asset

---

## Purpose

Model the three major pairs in scope against their rate anchors: spot vs 2Y and 10Y yield differentials, plus a rolling OLS attribution decomposing each pair's returns into the part explained by differential changes and a residual. Pairs follow the four-market scope: **EURUSD (DE − US)**, **USDJPY (US − JP)**, **GBPUSD (UK − US)**.

**Scope honesty:** the full nominal/real/inflation differential split requires real yields on both legs. Free daily real yields exist only for US (TIPS via FRED) and UK (index-linked gilts via BoE IADB). Therefore:
- All three pairs: **nominal differentials** at 2Y and 10Y + OLS attribution
- GBPUSD only: additional **real and inflation differential** decomposition
- EURUSD/USDJPY real legs: v2, pending a DE/JP real yield source. Do NOT proxy with unrelated series.

---

## Data Sources

| Data | Source | Details |
|---|---|---|
| EURUSD spot | yfinance | `EURUSD=X` |
| USDJPY spot | yfinance | `USDJPY=X` |
| GBPUSD spot | yfinance | `GBPUSD=X` |
| US 2Y/10Y | FRED (existing) | `DGS2`, `DGS10` |
| US real 2Y/10Y | FRED (existing) | `DFII2`, `DFII10` |
| DE 2Y/10Y | Global Rates adapter (existing) | ECB Data Portal |
| UK 2Y/10Y | Global Rates adapter (existing) | BoE IADB |
| UK real 2Y/10Y | BoE IADB (extend existing UK adapter) | Index-linked gilt zero-coupon real yields — series codes `IUDMIZC` (2Y real proxy) and `IUDMRIZ` (10Y real); VERIFY codes against returned data on first build, BoE real curve short-end availability starts ~2.5Y so use the shortest available and label it honestly |
| JP 2Y/10Y | Global Rates adapter (existing) | MoF JGB CSV |

**Differential conventions (match the reference):**
- EURUSD: DE minus US (positive differential = EUR-supportive)
- USDJPY: US minus JP (positive = USD-supportive → pair up)
- GBPUSD: UK minus US (positive = GBP-supportive)

**Lookback:** 2Y daily history for everything. All series aligned to the FX pair's own trading calendar (FX trades ~5.5 days/week via yfinance daily bars — align to US business days, forward-fill yields max 3 days).

---

## Backend — `backend/routers/fx.py`

**Router prefix:** `/api/fx`

### Compute logic (per pair)

**1. Differentials:**
```python
diff_2y  = base_leg_2y  - quote_leg_2y    # in percentage points; report in bp
diff_10y = base_leg_10y - quote_leg_10y
```
For GBPUSD additionally:
```python
real_diff_10y = uk_real_10y - us_real_10y
inf_diff_10y  = (uk_10y - uk_real_10y) - (us_10y - us_real_10y)
# identity: nominal_diff = real_diff + inf_diff — force inf = nom - real
```

**2. Rolling OLS attribution (the reference's model):**
For each pair and each tenor (2Y, 10Y):
- `y` = pair's rolling 20D log return (%)
- `x` = 20D change in the differential (bp)
- Univariate OLS with a 20D estimation lookback, rolled daily:
  - `beta_t` = regression coefficient over the trailing 20 observations
  - `explained_t = beta_t * dx_t` (the differential-explained portion of the 20D return)
  - `residual_t = y_t - explained_t`
- Output per day: `{ date, actual_20d, explained, residual }` — components net exactly to the actual return
- Also report `driver_share`: `abs(explained) / (abs(explained) + abs(residual))` for the latest observation, as a percent

**3. Current reading per pair:**
- Spot, 1M % change
- 2Y and 10Y differentials (bp) + 1M change in each
- Latest 20D attribution split at both tenors: which tenor's differential currently explains more (`driver_tenor`)
- For GBPUSD: real vs inflation differential levels + 1M changes + which leg drove the 1M differential move

### Endpoint

**`GET /api/fx/snapshot`**
Query params: `ols_lookback` (int, default 20) · `ret_window` (int, default 20)

```json
{
  "as_of": "2026-07-16",
  "pairs": {
    "EURUSD": {
      "spot": 1.1436, "spot_1m_pct": -0.3,
      "convention": "DE minus US",
      "diff_2y_bp": -138, "diff_2y_1m_chg": 17,
      "diff_10y_bp": -142, "diff_10y_1m_chg": 9,
      "attribution_2y": [ { "date": "2025-09-01", "actual_20d": -1.2, "explained": -0.6, "residual": -0.6 } ],
      "attribution_10y": [ { "..." : "..." } ],
      "current": {
        "driver_tenor": "2Y",
        "explained_share_2y": 54, "explained_share_10y": 32,
        "beta_2y": 0.021, "beta_10y": 0.014
      },
      "decomposition": null
    },
    "USDJPY": { "...same shape...", "convention": "US minus JP" },
    "GBPUSD": {
      "...same shape...",
      "convention": "UK minus US",
      "decomposition": {
        "real_diff_10y_bp": -49, "real_diff_1m_chg": 3,
        "inf_diff_10y_bp": 89, "inf_diff_1m_chg": 5,
        "driver_leg_1m": "INFLATION", "driver_leg_pct": 62,
        "real_series": [ { "date": "2025-07-17", "real_diff": -52, "inf_diff": 85, "nom_diff": 33 } ]
      }
    }
  },
  "spot_series": {
    "EURUSD": [ { "date": "2025-07-17", "spot": 1.1620, "diff_2y": -155, "diff_10y": -151 } ],
    "USDJPY": [ "..." ], "GBPUSD": [ "..." ]
  }
}
```

Graceful degradation: if a pair's yield leg fails to fetch (e.g. ECB adapter down), exclude that pair, include it in `failed_pairs`, render the rest.

---

## Frontend — `frontend/app/fx/page.tsx`

Reference: Capital Flows FX pages (EURUSD/USDJPY/GBPUSD rate differential models).

### Header
- Section label: `FX`
- Title: "FX · Rate Differential Models"
- Subtitle: "Spot vs 2Y and 10Y differentials · rolling OLS return attribution"
- LIVE badge · Refresh

### KPI strip (3 cards)
One per pair: `EURUSD 1.1436 · 1M -0.3%` — pair name, spot large, 1M change colored

### Pair selector
Tab-style toggle: `EURUSD | USDJPY | GBPUSD` — amber active state, switches all content below. (Single-pair view keeps the page readable; the reference uses one page per pair, we use one page with tabs.)

### Per-pair layout (rendered for the selected pair)

**Differentials vs Spot chart (2Y):**
- Section title: `2Y DIFFERENTIAL VS SPOT`
- Subtitle: `<CONVENTION> · 2Y · EACH LINE ON ITS OWN SCALE · 2Y LOOKBACK`
- Dual-axis LineChart: spot (white, left axis) + 2Y differential in bp (blue, right axis)
- Tooltip: date, spot, differential

**Differentials vs Spot chart (10Y):** same layout, 10Y differential (orange line)

**Attribution charts (2Y and 10Y side by side):**
- Section titles: `2Y ATTRIBUTION` / `10Y ATTRIBUTION`
- Subtitle: `ROLLING 20D RETURNS · UNIVARIATE OLS LOOKBACK 20D · COMPONENTS NET TO THE LINE`
- Stacked BarChart: `explained` (blue bars) + `residual` (gray bars, `#6b7280`), stacked; `actual_20d` white Line overlay
- Same pattern as the Rate Decomp attribution charts — reuse the component pattern

**GBPUSD only — Real/Inflation Differential panel:**
- Section title: `10Y DIFFERENTIAL DECOMPOSITION · UK MINUS US`
- LineChart: nominal diff (white), real diff (blue), inflation diff (orange) — all bp, shared axis
- Reading chips: `NOM +40bp` · `REAL -49bp` · `INF +89bp` · `1M DRIVER: INFLATION 62%`
- For EURUSD/USDJPY, render a muted placeholder card in this slot: `REAL/INFLATION SPLIT UNAVAILABLE · NO FREE DAILY REAL YIELD SOURCE FOR DE/JP · NOMINAL ONLY`

**WHAT THIS IS / CURRENT READING panels:**
- WHAT THIS IS: "Each pair is shown against its rate anchors at both ends of the curve. The stacked bars decompose the pair's rolling 20-day returns onto 20-day differential changes through a rolling univariate OLS; the residual closes the gap so components net exactly to the return line. When the residual dominates, the pair is trading on something other than rates."
- CURRENT READING (per selected pair): spot + 1M · both differentials + 1M changes · driver tenor and explained shares · betas

---

## Page Layout Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Header · LIVE · Refresh                                     │
├───────────────┬───────────────┬─────────────────────────────┤
│ EURUSD card   │ USDJPY card   │ GBPUSD card                 │
├───────────────┴───────────────┴─────────────────────────────┤
│ Pair tabs: [EURUSD] USDJPY GBPUSD                           │
├──────────────────────────────┬──────────────────────────────┤
│ 2Y DIFF VS SPOT (dual axis)  │ 10Y DIFF VS SPOT (dual axis) │
├──────────────────────────────┼──────────────────────────────┤
│ 2Y ATTRIBUTION (stacked+line)│ 10Y ATTRIBUTION              │
├──────────────────────────────┴───────────────┬──────────────┤
│ GBPUSD: REAL/INF DECOMPOSITION               │ WHAT THIS IS │
│ (or unavailable placeholder for EUR/JPY)     │ CURRENT      │
│                                              │ READING      │
└──────────────────────────────────────────────┴──────────────┘
```

---

## Build Order

1. **Read** `global_rates_service.py` — confirm the DE/UK/JP adapters expose 2Y/10Y history in a reusable form; if history is buried inside the router, refactor the adapters to return it (behavior of the global-rates endpoint unchanged)
2. Extend the UK adapter with the real yield series (verify BoE codes against live data; report substitutions)
3. Build `fx.py`: differentials → rolling OLS attribution → GBPUSD decomposition; force the GBPUSD identity `inf = nom − real`
4. Sanity checks before wiring frontend: differential signs match conventions (US 2Y > DE 2Y ⇒ EURUSD diff negative), attribution components sum to actual within tolerance, betas are small positive numbers for USDJPY (rate-differential beta should be positive under US-minus-JP convention)
5. Register router; `curl` and verify all three pairs present
6. Build frontend with pair tabs
7. Sidebar: FX after Cross-Asset
8. `npm run build` — zero type errors

## Notes for Claude Code

- Reuse, don't refetch: DE/UK/JP yields must come through the existing global-rates adapters and shared cache — a second fetching path for the same data is a bug
- OLS: `numpy.polyfit(x, y, 1)` on the trailing window is sufficient; guard degenerate windows (x variance ~0 → beta 0, explained 0, residual = actual)
- yfinance FX tickers return MultiIndex columns — `.squeeze("columns")` pattern
- Attribution identity: after computing explained, ALWAYS set `residual = actual - explained` rather than computing independently
- 20D log returns: `np.log(spot / spot.shift(20)) * 100`
- The pair selector is client-side state only — all three pairs arrive in one snapshot call; no per-tab refetching
- BoE real yield short end starts around 2.5Y maturity — if the 2Y real code returns empty, use the shortest available real tenor for the GBPUSD real leg and label the tenor honestly in the response (`"real_leg_tenor": "3Y"`)
