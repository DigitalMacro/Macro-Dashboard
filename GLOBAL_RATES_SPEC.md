# MFERM Dashboard — Module Addition: Global Rates
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/services/global_rates_service.py` (per-market data adapters)
- `backend/routers/global_rates.py`
- `frontend/app/global-rates/page.tsx`

**Files to read first:**
- `backend/services/fred_service.py` (or wherever the shared FRED helper lives after the Rate Decomp build) — reuse for US data
- `backend/routers/yield_curve.py` — reuse `classify_yield_curve()` for per-market regime classification
- `backend/cache/simple_cache.py` — use `cached_fetch` for all external calls

**Wire into:**
- `backend/main.py`: register global_rates router
- Sidebar: add "Global Rates" nav item → `/global-rates`, positioned after Yield Curve, before Regime Matrix

---

## Purpose

Four major rates markets side by side: US, Eurozone (German benchmark), UK, Japan. Full curve snapshots, 10Y yield overlay with per-market normalized scaling, 2s10s slope ranking, policy rates, and per-market curve regime classification using the existing framework. Built with per-market adapters so additional markets (Australia, Canada, Switzerland) can be added prospectively without restructuring.

**Markets in v1:** US, DE (euro area benchmark), UK, JP. The adapter registry pattern must make adding a 5th market a matter of writing one new adapter function plus one config entry.

---

## Data Sources — Per-Market Adapters

All adapters live in `backend/services/global_rates_service.py`. Each returns the same normalized shape so downstream compute is market-agnostic.

### Adapter interface

Every adapter implements:
```python
async def fetch_<market>_yields(lookback_days: int = 400) -> dict:
    """
    Returns:
    {
        "market": "UK",
        "tenors": {                    # latest curve snapshot, percent
            "2Y": 4.35, "5Y": 4.52, "10Y": 4.95, "30Y": 5.42
        },
        "history": {                   # daily series per tenor, pd.Series date-indexed
            "2Y": <series>, "10Y": <series>   # 2Y and 10Y minimum; 5Y/30Y if available
        },
        "policy_rate": 3.75,           # current policy rate, percent
        "as_of": "2026-07-16",
        "source": "Bank of England IADB"
    }
    """
```

Required tenors: 2Y and 10Y (daily history) — these drive the overlay, slope ranking, and regime classification. 5Y and 30Y: include in the latest snapshot if the source provides them; history optional.

### US — FRED (existing infrastructure)
- `DGS2`, `DGS5`, `DGS10`, `DGS30` via the shared FRED helper — already fetched by other modules; rely on the existing cache
- Policy rate: `DFF` (effective fed funds)

### Eurozone (DE benchmark) — ECB Data Portal API
- Free REST, no API key. Base: `https://data-api.ecb.europa.eu/service/data/`
- German benchmark government bond yields via the ECB's FM dataset. Daily frequency series keys (verify exact keys against the API on first build — the ECB SDW key format is `FM/B.U2.EUR.4F.BB.U2_2Y.YLD` style for benchmark bond yields; if the FM dataset keys fail, fall back to the YC dataset — euro area AAA yield curve spot rates: `YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y` etc.)
- Request format: append `?format=jsondata&lastNObs=400` for JSON with history
- Policy rate: ECB deposit facility rate — FRED series `ECBDFR` (simpler than parsing ECB API for this one value)
- Parse the SDMX-JSON structure: observations live under `dataSets[0].series[<key>].observations`, dates under `structure.dimensions.observation[0].values`

### UK — Bank of England IADB
- Free CSV endpoint, no key. Base: `https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp`
- Daily government liability curve (gilt) zero-coupon yields. Series codes: `IUDMNZC` (2Y), `IUDSNZC` (5Y), `IUDMRZC` (10Y), `IUDLRZC` (20Y — use as 30Y proxy, label it "20Y" honestly in the UI)
- CSV request pattern: `?csv.x=yes&Datefrom=<DD/Mon/YYYY>&Dateto=now&SeriesCodes=IUDMNZC,IUDSNZC,IUDMRZC,IUDLRZC&CSVF=TN&UsingCodes=Y&VPD=Y`
- Parse with pandas `read_csv` from the response text
- Policy rate: Bank Rate — FRED series `IUDSOIA` is SONIA not Bank Rate; use BoE IADB series `IUDBEDR` (official Bank Rate) in the same CSV call
- **Note:** verify series codes on first build by fetching and inspecting; BoE codes are stable but the exact zero-coupon vs par curve codes should be confirmed against returned data

### Japan — Ministry of Finance JGB CSV
- Free CSV download, no key: `https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv`
- Contains full JGB par yield curve history (1Y through 40Y), daily, updated each business day
- Columns include 2Y, 5Y, 10Y, 30Y directly — parse date column + needed tenors
- File contains full history from 1974 — large. Fetch once, cache aggressively (TTL 4h), and slice the last `lookback_days`
- Policy rate: BoJ uncollateralized overnight call rate target — no clean FRED daily series; hard-code in the market config dict with a `policy_rate_manual: true` flag and a comment noting it needs manual updates on BoJ policy changes. Current value: set from the most recent BoJ announcement.

### Market registry

```python
MARKETS = {
    "US": {"name": "United States", "adapter": fetch_us_yields,  "color": "#F0F0F0", "policy_source": "FRED:DFF"},
    "DE": {"name": "Euro Area",     "adapter": fetch_de_yields,  "color": "#38bdf8", "policy_source": "FRED:ECBDFR"},
    "UK": {"name": "United Kingdom","adapter": fetch_uk_yields,  "color": "#f59e0b", "policy_source": "BoE:IUDBEDR"},
    "JP": {"name": "Japan",         "adapter": fetch_jp_yields,  "color": "#f87171", "policy_source": "manual"},
}
```

Adding a market prospectively = one adapter function + one registry entry. Nothing else changes.

### Graceful degradation — REQUIRED

Wrap each adapter call in try/except at the router level. If a market's fetch fails:
- Exclude it from the response
- Add its code to a `failed_markets` list in the response
- Log the exception
- NEVER let one market's failure 500 the whole endpoint

Frontend renders whatever markets arrive and shows a small muted notice for failed ones: `JP unavailable · source fetch failed`.

---

## Backend — `backend/routers/global_rates.py`

**Router prefix:** `/api/global-rates`

### Compute logic (market-agnostic, runs on adapter output)

For each successfully fetched market:
1. **2s10s slope** (bps): `(y10 - y2) * 100` from latest snapshot
2. **1M changes** (bps): each tenor's latest vs 21 sessions ago
3. **10Y normalized series** for the overlay chart: `(value - min_1y) / (max_1y - min_1y)` over the trailing 1Y window — this reproduces the reference's per-market axis scaling so all lines are readable on one chart
4. **Curve regime**: run the existing `classify_yield_curve()` (import from yield_curve router or shared location — do not duplicate) on each market's 2Y/10Y changes over a 10-day window with the same 2bp threshold. Include days-in-regime per market.
5. **US vs peer median**: US 10Y minus median of the other markets' 10Y, in bps

### Endpoint

**`GET /api/global-rates/snapshot`**
Query params: `window` (int, days for regime classification, default 10)

```json
{
  "as_of": "2026-07-16",
  "failed_markets": [],
  "markets": {
    "US": {
      "name": "United States",
      "color": "#F0F0F0",
      "policy_rate": 3.63,
      "tenors": { "2Y": 4.17, "5Y": 4.28, "10Y": 4.55, "30Y": 5.07 },
      "changes_1m_bps": { "2Y": 1, "5Y": 7, "10Y": 12, "30Y": 19 },
      "slope_2s10s_bps": 38,
      "regime": "bear_steepener",
      "days_in_regime": 2,
      "curve_snapshot": { "tenors": ["2Y","5Y","10Y","30Y"], "yields": [4.17,4.28,4.55,5.07] },
      "overlay_10y": [
        { "date": "2025-07-17", "normalized": 0.42, "raw": 4.31 }
      ]
    },
    "DE": { "...": "..." },
    "UK": { "...": "..." },
    "JP": { "...": "..." }
  },
  "slope_ranking": [
    { "market": "JP", "slope_bps": 126 },
    { "market": "UK", "slope_bps": 60 },
    { "market": "US", "slope_bps": 38 },
    { "market": "DE", "slope_bps": 34 }
  ],
  "summary": {
    "steepest": "JP",
    "flattest": "DE",
    "inverted_count": 0,
    "top_1m_riser_10y": "UK",
    "us_10y": 4.55,
    "peer_median_10y": 3.13,
    "us_vs_median_bps": 142
  }
}
```

Cache the full snapshot build with `cached_fetch`, TTL 4 hours (these are daily-close series; no benefit to shorter).

---

## Frontend — `frontend/app/global-rates/page.tsx`

Follow the established design system. Reference the Capital Flows "Global · 10Y Yields" and "Global · Yield Curves" pages.

### Header
- Section label: `GLOBAL RATES`
- Title: "Global · Rates"
- Subtitle: "US, Euro Area, UK and Japan curves side by side · daily close"
- LIVE badge · Refresh button

### Policy rate cards (4 across)
One card per market: market name (in its registry color), policy rate large, source sub-label:
```
FED 3.63%  ·  ECB 2.40%  ·  BOE 3.75%  ·  BOJ 1.00%
```

### 10Y Yield Overlay chart
- Section title: `10Y NOMINAL YIELD OVERLAY`
- Subtitle: `PER-MARKET AXIS · EACH LINE SCALED TO ITS OWN 1Y RANGE · DAILY CLOSE`
- Recharts LineChart, 1Y of daily data:
  - One line per market using `normalized` values (0–1 scale), colored by registry color
  - NO shared y-axis labels (the values are normalized) — hide the y-axis ticks, show a muted caption: `NO SHARED Y SCALE — EACH MARKET NORMALIZED TO ITS OWN 1Y MIN/MAX`
  - Tooltip shows the RAW yield per market, not the normalized value: `US 4.55% · UK 4.95% · DE 3.13% · JP 2.70%`
  - Legend: market codes in their colors
- Right-side column — `1M CHANGE` table:
  - One row per market: code (colored), latest 10Y level, 1M change in bps (green positive / red negative)
  - Sorted by 1M change descending

### Curve Snapshots chart
- Section title: `NOMINAL CURVE SNAPSHOTS`
- Subtitle: `LATEST CLOSE · TENORS 2Y 5Y 10Y 30Y · PERCENT`
- Recharts LineChart, categorical x-axis (tenor labels):
  - One line per market with dots at each tenor, colored by registry color
  - Shared y-axis (real percent values — unlike the overlay, curves plot on one scale)
  - UK 30Y point: if using the 20Y proxy, label the tooltip honestly as `20Y`
- Right-side column — `2S10S SLOPE` ranking:
  - Horizontal bar per market, sorted steepest first
  - Bar length proportional to slope, green fill; red if negative (inverted)
  - Value label: `+126bp`
  - Below ranking, summary chips: `STEEPEST JP +126bp` · `FLATTEST DE +34bp` · `INVERTED 0 OF 4`

### Per-market regime strip
- Section title: `CURVE REGIMES · 10D WINDOW`
- Four chips in a row, one per market:
  `US · BEAR STEEPENER · 2D` — regime name in the regime color palette from the yield curve module, market code in registry color
- Reuses the exact regime colors already defined (bull_steepener green, bear_steepener red, etc.)

### "WHAT THIS IS" / "CURRENT READING" panel
Same card style as Rate Decomp module:
- WHAT THIS IS: "Ten-year yields are the anchor point of every rates market. Each overlay line is drawn on its own axis, scaled to its own one-year range, so every market's shape is readable next to the others — levels differ for structural reasons, so the one-month change column is the cleaner cross-market signal."
- CURRENT READING: steepest, flattest, US vs peer median, top 1M riser — from the `summary` object

---

## Page Layout Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Header · LIVE badge · Refresh                               │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│ FED 3.63%   │ ECB 2.40%   │ BOE 3.75%   │ BOJ 1.00%        │
├─────────────┴─────────────┴─────────────┴───┬───────────────┤
│ 10Y YIELD OVERLAY (normalized, 1Y)          │ 1M CHANGE     │
│ 4 lines, per-market scaling                 │ table         │
├─────────────────────────────────────────────┼───────────────┤
│ NOMINAL CURVE SNAPSHOTS (2Y–30Y)            │ 2S10S SLOPE   │
│ 4 curves, shared axis                       │ ranking bars  │
├─────────────────────────────────────────────┴───────────────┤
│ CURVE REGIMES strip: US · DE · UK · JP chips                │
├─────────────────────────────────────────────────────────────┤
│ WHAT THIS IS · CURRENT READING panels                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Build Order

1. **Read** the shared FRED service and `yield_curve.py` to locate `classify_yield_curve()` and the fetch/cache patterns
2. Build `backend/services/global_rates_service.py`: US adapter first (trivial, reuses FRED), then JP (simple CSV), then UK (CSV with param URL), then DE (SDMX-JSON, most complex)
3. **Verify each adapter independently** with a direct call before wiring the router — print the returned tenor dict and confirm values are sane (e.g. JP 10Y between 0% and 5%, UK 10Y between 3% and 6%)
4. Build `backend/routers/global_rates.py` with graceful degradation wrapping
5. Register in `main.py`; confirm `curl http://localhost:8000/api/global-rates/snapshot` returns all four markets
6. Build `frontend/app/global-rates/page.tsx`
7. Update sidebar: Global Rates after Yield Curve
8. `npm run build` — zero type errors

## Notes for Claude Code

- The ECB and BoE URL formats above are the standard documented patterns but MUST be verified against live responses on first build — if a series key 404s or returns empty, inspect the API's own discovery endpoints rather than guessing variants blindly, and report what was substituted
- JGB CSV has header rows before the data and uses full-width characters in some fields — inspect the raw first 10 lines before writing the parser
- All external fetches: `httpx.AsyncClient` with 20s timeout, wrapped in the existing cache
- Do NOT install new dependencies without checking requirements.txt first — pandas/httpx cover everything needed
- The normalized overlay requires each market's own 1Y min/max — compute per market, never globally
- Regime classification: import from the existing module; if it's not cleanly importable, refactor it into `backend/services/curve_service.py` and update the yield_curve router's import (behavior unchanged), same pattern as prior refactors
- JP policy rate is hard-coded with a manual-update flag — surface it in the response as `"policy_rate_manual": true` so the frontend can show a subtle `·` marker
