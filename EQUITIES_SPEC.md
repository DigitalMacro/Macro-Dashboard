# MFERM Dashboard — Module Addition: Equities & Earnings
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/routers/equities.py`
- `frontend/app/equities/page.tsx`

**Files to read first:**
- `backend/cache/simple_cache.py`
- An existing frontend module for chart/card patterns

**Wire into:**
- `backend/main.py`: register equities router
- Sidebar: add "Equities" nav item → `/equities`, positioned after FX, before MFERM

---

## Purpose

Drill into the equity leg of the cross-asset picture: which sectors are carrying the index, how broad the move is, where each sector sits in the leadership cycle, and risk-adjusted momentum ranks. Reference: Capital Flows "SPX · Sector Attribution", "Breadth & Dispersion", "Rotation & Momentum".

**Scope honesty — Earnings vs Valuation:** the reference's fourth panel decomposes index returns into forward-earnings growth and multiple change. That requires a daily history of forward EPS estimates, which has NO free source (yfinance exposes only current-snapshot forward P/E, not history). v1 ships without this panel. The spec includes a stubbed endpoint and a greyed UI card wired to activate if an `FMP_API_KEY` is later added to `.env` (Financial Modeling Prep free tier carries analyst estimates). Do NOT simulate the panel with trailing earnings labeled as forward.

---

## Data Sources — All yfinance, All Free

**Index:** `SPY` (S&P 500 proxy; label honestly as SPY in tooltips)

**11 GICS sector ETFs:**
```python
SECTORS = {
    "XLK": "Info Tech",     "XLV": "Health Care",   "XLF": "Financials",
    "XLY": "Consumer Disc", "XLC": "Comm Services", "XLI": "Industrials",
    "XLP": "Consumer Staples", "XLE": "Energy",     "XLU": "Utilities",
    "XLRE": "Real Estate",  "XLB": "Materials",
}
```

**Sector weights:** true SPX GICS weights are licensed data. Use a hardcoded config dict of approximate current weights (source: latest publicly stated SPDR sector weights), flagged `weights_manual: true` with an as-of date, normalized to sum to 1.0:
```python
SECTOR_WEIGHTS_ASOF = "2026-07"   # update manually ~quarterly
SECTOR_WEIGHTS = { "XLK": 0.32, "XLF": 0.13, "XLV": 0.11, ... }  # normalize on load
```
The attribution residual (index return minus weighted sector sum) is shown honestly in the UI — with approximate weights it will be larger than the reference's ±0.01pp; that's expected and disclosed.

**Lookback:** 2Y daily for all tickers, one batched `yf.download`, 4h cache TTL.

---

## Backend — `backend/routers/equities.py`

**Router prefix:** `/api/equities`

### 1. Sector Attribution
- Per sector: 21D rolling return × weight = contribution (pp)
- Index 21D return (SPY) as the check line
- `residual = index_ret − Σ contributions`
- Daily series over 1Y for the stacked chart; latest snapshot for the table
- Per-sector table: outright 21D return + weighted contribution, sorted by contribution

### 2. Breadth & Dispersion
- **Breadth:** share of the 11 sector ETFs trading above their own 50D SMA, daily, 1Y series + current value + 1Y percentile
- **Dispersion:** cross-sectional stdev of the 11 sectors' trailing 21D returns, daily, 1Y series + current + 1Y percentile

### 3. Rotation Map (RRG-style)
Weekly relative strength vs SPY, per sector:
- `rs = sector_price / spy_price`, resampled weekly
- **RS-Ratio:** 100 × rs / SMA10(rs) — normalized around 100
- **RS-Momentum:** 100 × rs_ratio / SMA10(rs_ratio)
- Output per sector: current (ratio, momentum) + trailing 10 weekly points for the tail
- Quadrants: Leading (ratio>100, mom>100) · Weakening (>100, <100) · Lagging (<100, <100) · Improving (<100, >100)

### 4. Vol-Scaled Momentum Ranks
Per sector: `(21D sector return − 21D SPY return) / sector 21D daily-return stdev`, smoothed EMA5. Ranked descending. Positive = beating the index per unit of risk.

### 5. Earnings vs Valuation — STUB
```python
FMP_API_KEY = os.getenv("FMP_API_KEY", "")
# if empty: return {"available": false, "reason": "requires FMP_API_KEY for forward estimates"}
# if set (v2): fetch SPY constituent-weighted forward EPS, decompose 20D return into earnings vs multiple
```

### Endpoint

**`GET /api/equities/snapshot`**
Query params: `attr_window` (int, default 21)

```json
{
  "as_of": "2026-07-16",
  "index": { "level": 7479, "ret_1m_pct": 1.65, "ticker": "SPY" },
  "weights_asof": "2026-07",
  "attribution": {
    "series": [ { "date": "2025-07-17", "XLK": -0.19, "XLF": 0.58, "...": 0, "index_ret": 1.65, "residual": 0.12 } ],
    "table": [ { "ticker": "XLF", "name": "Financials", "outright_pct": 5.0, "contrib_pp": 0.58 } ],
    "top_contributor": "XLF", "bottom_contributor": "XLK",
    "best_sector": "XLE", "worst_sector": "XLB",
    "residual_pp": 0.12
  },
  "breadth": { "series": [ { "date": "...", "value": 0.64 } ], "current": 0.64, "percentile_1y": 56 },
  "dispersion": { "series": [ { "date": "...", "value": 2.62 } ], "current": 2.62, "percentile_1y": 16 },
  "rotation": [
    { "ticker": "XLE", "name": "Energy", "rs_ratio": 102.1, "rs_momentum": 101.4,
      "quadrant": "leading", "tail": [ { "ratio": 101.0, "momentum": 100.2 } ] }
  ],
  "momentum_ranks": [ { "ticker": "XLF", "name": "Financials", "score": 3.51 } ],
  "earnings_valuation": { "available": false, "reason": "requires FMP_API_KEY" }
}
```

---

## Frontend — `frontend/app/equities/page.tsx`

### Header
- Section label: `EQUITIES & EARNINGS`
- Title: "SPX · Sectors & Momentum" · Subtitle: "Sector attribution, breadth, rotation and risk-adjusted momentum · SPY + GICS ETFs"
- LIVE badge · Refresh

### KPI strip (4 cards)
1. **SPX (SPY)** — level + 1M %
2. **Best Sector 1M** — e.g. `ENERGY +7.6%`
3. **Worst Sector 1M** — e.g. `MATERIALS -0.8%`
4. **Top Contributor 1M** — e.g. `FINANCIALS +0.58pp`

### Sector Contribution Stack
- Title: `SECTOR CONTRIBUTION STACK` · Subtitle: `21D ROLLING · 1Y · WEIGHT × RETURN · CUMULATIVE INDEX LINE`
- Stacked BarChart: 11 sector contribution series stacked (distinct hues from an 11-color categorical palette — define once, reuse in every panel), white Line overlay = index 21D return
- Right column — `PER-SECTOR BREAKDOWN · 1M` table: sector name (in its palette color) · outright % (with mini horizontal bar) · contribution pp; sorted by contribution; green/red coloring
- Below table, muted note: `WEIGHTS: STATIC APPROX (AS OF {weights_asof}) · RESIDUAL {residual_pp}pp`

### Breadth & Dispersion (two charts side by side)
- **Breadth:** area chart, share above 50D SMA, y-domain [0,1] shown as %, ReferenceLine at 50%. Chip: `BREADTH 64% · 1Y %ILE 56`
- **Dispersion:** line chart, pp, chip: `DISPERSION 2.62pp · 1Y %ILE 16`
- Shared caption explaining low dispersion = one macro driver moving everything

### Sector Rotation Map
- Title: `SECTOR ROTATION MAP` · Subtitle: `RS RATIO VS RS MOMENTUM · WEEKLY · SMA10 · 10-POINT TRAIL`
- ScatterChart, square aspect: x = RS-Ratio, y = RS-Momentum, ReferenceLines at 100/100
- Quadrant labels (muted, corners): `LEADING` (top-right) · `WEAKENING` (bottom-right) · `LAGGING` (bottom-left) · `IMPROVING` (top-left)
- Per sector: 10-week tail as small connected dots fading in opacity, head point larger with sector ticker label
- Sector colors from the shared 11-color palette

### Vol-Scaled Momentum Ranks
- Title: `VOL-SCALED MOMENTUM RANKS` · Subtitle: `21D VS INDEX · EMA5 · UNITLESS`
- Horizontal bar chart, sorted: positive bars green, negative red, value labels (`+3.510`)
- Caption: "Each sector's 21-day return is scaled by its own volatility and compared with the index on the same basis."

### Earnings vs Valuation — greyed card
- Muted card: `EARNINGS VS VALUATION · UNAVAILABLE` + one line: `Forward EPS estimate history requires a paid estimates feed. Add FMP_API_KEY to enable.` No fake chart.

### WHAT THIS IS / CURRENT READING panels
- WHAT THIS IS: "Each bar splits the trailing index move into the part every GICS sector contributed — weight times return — so the chart shows who is carrying the tape rather than who merely rallied. Breadth and dispersion show how broad the move is beneath the surface; the rotation map places each sector in its leadership cycle."
- CURRENT READING: 1M index · top/bottom contributors · breadth + percentile · dispersion + percentile · top momentum rank

---

## Page Layout Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Header · LIVE · Refresh                                     │
├──────────┬───────────────┬───────────────┬──────────────────┤
│ SPX      │ BEST SECTOR   │ WORST SECTOR  │ TOP CONTRIBUTOR  │
├──────────┴───────────────┴───────┬───────┴──────────────────┤
│ SECTOR CONTRIBUTION STACK (1Y)   │ PER-SECTOR TABLE · 1M    │
│ stacked bars + index line        │ outright vs contrib      │
├────────────────────┬─────────────┴──────────────────────────┤
│ BREADTH (1Y area)  │ DISPERSION (1Y line)                   │
├────────────────────┴────────────┬───────────────────────────┤
│ SECTOR ROTATION MAP (square)    │ VOL-SCALED MOMENTUM RANKS │
├─────────────────────────────────┼───────────────────────────┤
│ EARNINGS VS VALUATION (greyed)  │ WHAT THIS IS · READING    │
└─────────────────────────────────┴───────────────────────────┘
```

---

## Build Order

1. **Read** cache module + an existing frontend page for patterns
2. One batched `yf.download` for SPY + 11 ETFs; `.squeeze("columns")` / MultiIndex handling per established pattern
3. Attribution math; verify: Σ(contrib) + residual = index return exactly; residual magnitude reported, not hidden
4. Breadth, dispersion, rotation, momentum ranks; sanity-check rotation quadrants against recent sector performance (a sector up strongly vs SPY over 2–3 months should sit Leading/Improving)
5. Register router; `curl` verify all panels populated, `earnings_valuation.available == false`
6. Frontend; define the 11-color sector palette once as a shared constant
7. Sidebar: Equities after FX
8. `npm run build` — zero type errors

## Notes for Claude Code

- ONE batched download for all 12 tickers — never 12 sequential calls
- Weekly resample for rotation: `resample("W-FRI").last()`, min 30 weeks history before SMA10 chains produce valid output
- RRG tails: guard sectors with insufficient history — emit shorter tails rather than NaN points
- The 11-color palette must be colorblind-considerate and distinct on the dark background; avoid reusing the regime palette colors for sectors to prevent cross-module confusion
- Stacked bars with 11 series can render slowly with 250 daily points — downsample the attribution series to every 2nd day if Recharts performance degrades (test first)
- SECTOR_WEIGHTS values: set from the most recently published SPDR/S&P sector weights at build time; normalize to 1.0 in code; include `weights_asof` in the response
