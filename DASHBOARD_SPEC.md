# MFERM Dashboard — Full Build Specification
**Project path:** `<project root>`
**Stack:** Next.js 14 (frontend/) + FastAPI (backend/) + Python .venv inside backend/
**Entry points:** `backend/main.py` · `frontend/app/`
**Servers:** FastAPI on port 8000 · Next.js on port 3001 · `/api/*` proxied via `next.config.mjs`
**Constraints:** Recharts only (no other chart libs) · Tailwind only (no component libs except shadcn/ui) · All secrets via `backend/.env`

---

## Design System

All modules share a unified dark fintech aesthetic. Never use default Tailwind color names — use these exact values throughout:

```
--bg:            #0a0a0d        (page background)
--surface:       #111116        (card/panel background)
--border:        rgba(255,255,255,0.07)
--text-primary:  #F0F0F0
--text-muted:    #6b7280
--accent-blue:   #38bdf8        (growth / rates)
--accent-orange: #fb923c        (inflation)
--accent-amber:  #f59e0b        (LIVE badge, active toggles)
--accent-green:  #34d399        (positive returns)
--accent-red:    #f87171        (negative returns / inversions)
```

**Typography:** All labels 10–11px, uppercase, monospace, tracking-widest. Values 20–24px monospace tabular-nums. Body 12–13px.

**Cards:** `background: var(--surface)` · `border: 1px solid var(--border)` · `border-radius: 8px` · `padding: 20px`

**LIVE badge:** `text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30`

**Toggle buttons (active):** `bg-amber-500/20 text-amber-400 border border-amber-500/40`
**Toggle buttons (inactive):** `text-neutral-500 border border-neutral-700`

**Regime colors:**
```
run_it_hot:  #B45309  (amber/orange)
stagflation: #991B1B  (deep red)
goldilocks:  #166534  (deep green)
debasement:  #1E3A5F  (deep blue)
```

**Yield curve regime colors:**
```
bull_steepener: #166534
bear_steepener: #991B1B
bull_flattener: #1E3A5F
bear_flattener: #B45309
twist_bear:     #6B21A8
twist_bull:     #0E7490
```

**Heatmap cell colors by return:**
```
≥ +3%:   bg-emerald-900/60  text-emerald-300
+1–3%:   bg-emerald-900/30  text-emerald-400
0–+1%:   bg-neutral-800     text-neutral-300
-1–0%:   bg-red-900/30      text-red-400
≤ -1%:   bg-red-900/60      text-red-300
```

---

## Sidebar Navigation

File: `frontend/components/ui/Sidebar.tsx`

Nav items in order:
1. **STIR** → `/stir` (existing)
2. **MFERM** → `/mferm` (existing)
3. **Regime Matrix** → `/regime` (new — files already placed)
4. **Yield Curve** → `/yield-curve` (new — build now)
5. **Correlations** → `/correlations` (placeholder — coming soon, greyed out)
6. **Calendar** → `/calendar` (placeholder — coming soon, greyed out)

Active state: `background: rgba(245,158,11,0.12); color: #f59e0b; border-left: 2px solid #f59e0b`
Inactive: `color: #6b7280`
Coming soon items: `color: #374151; cursor: not-allowed` with a small `SOON` badge

---

## Module 1 — Regime Matrix (files already placed, wire only)

**Files already in place:**
- `backend/routers/regime.py`
- `frontend/app/regime/page.tsx`

**Wiring required:**
1. In `backend/main.py`: add `from routers.regime import router as regime_router` and `app.include_router(regime_router)`
2. Confirm `/api/regime/snapshot` returns 200
3. Add "Regime Matrix" to sidebar as above

**Endpoint:** `GET /api/regime/snapshot`
**Query params:** `method` (roc|zscore) · `roc_window` (int) · `market_weight` (float 0–1)

**Data sources (all via FRED):**
- Inflation axis: `CPIAUCSL` (CPI), `PCEPI` (PCE), `T5YIFR` (5y5y breakeven)
- Growth axis: `T10Y2Y` (2s10s spread), HYG/LQD ratio via yfinance
- All secrets from `backend/.env` — `FRED_API_KEY`

**Response shape:**
```json
{
  "current_regime": "stagflation",
  "current_growth": -0.42,
  "current_inflation": 0.88,
  "days_in_regime": 18,
  "growth_roc": -0.4,
  "inflation_roc": 0.9,
  "method": "roc",
  "quadrants": { "run_it_hot": { "label": "Run It Hot", "growth": "+", "inflation": "+", "color": "#B45309" }, ... },
  "time_series": [{ "date": "2024-01-01", "growth": -0.1, "inflation": 0.3, "regime": "stagflation" }],
  "asset_heatmap": { "SPX": { "run_it_hot": 2.1, "stagflation": -1.4, "goldilocks": 3.2, "debasement": -0.8 }, ... }
}
```

**Frontend layout (`frontend/app/regime/page.tsx` — already placed):**
- Header: title + LIVE badge + Refresh button
- Controls row: Method toggle (Rate of Change / Z-Score) · Market Weight (20/40/60%) · Window (1M/3M/6M)
- KPI strip (4 cards): Current Regime (color-coded) · Growth Score · Inflation Score · Days in Regime
- Main grid (3+2 cols): Quadrant 2×2 grid (left) + live dot position plot (right)
- Time series chart: growth + inflation scores, dual Y-axis, regime shading bands
- Asset heatmap table: assets as rows, regimes as columns, color-coded returns

---

## Module 2 — Yield Curve Regime (build from scratch)

**Files to create:**
- `backend/routers/yield_curve.py`
- `frontend/app/yield-curve/page.tsx`

**Wire into:**
- `backend/main.py`: `from routers.yield_curve import router as yield_curve_router` + `app.include_router(yield_curve_router)`
- Sidebar: "Yield Curve" → `/yield-curve`

### Backend: `backend/routers/yield_curve.py`

**Router prefix:** `/api/yield-curve`

**Data sources:**
- FRED `DGS2` — 2Y Treasury yield (daily)
- FRED `DGS10` — 10Y Treasury yield (daily)
- yfinance — SPY, TLT, GLD, BTC-USD, HYG, TIP for heatmap asset returns

**Regime classification logic:**

Compute over a configurable lookback window (default 21 business days):
- `d2y` = change in 2Y yield over window
- `d10y` = change in 10Y yield over window
- `d_spread` = d10y - d2y (change in 2s10s spread)
- `threshold` = 2bps minimum movement to avoid noise flips

Classification rules:
```python
def classify_yield_curve(d2y, d10y, threshold=0.02):
    spread_widening = (d10y - d2y) > threshold
    spread_narrowing = (d10y - d2y) < -threshold
    both_falling = d2y < -threshold and d10y < -threshold
    both_rising = d2y > threshold and d10y > threshold
    
    if spread_widening and both_falling:
        return "bull_steepener"    # both fall, long end falls less
    elif spread_widening and both_rising:
        return "bear_steepener"    # both rise, long end rises more
    elif spread_narrowing and both_falling:
        return "bull_flattener"    # both fall, short end falls less
    elif spread_narrowing and both_rising:
        return "bear_flattener"    # both rise, short end rises more
    elif d2y > threshold and d10y < -threshold:
        return "twist_bear"        # short rising, long falling
    elif d2y < -threshold and d10y > threshold:
        return "twist_bull"        # short falling, long rising
    else:
        return "neutral"
```

**Endpoints:**

`GET /api/yield-curve/snapshot`
Query params: `method` (roc|zscore) · `window` (int, days, default 21)

Response:
```json
{
  "current_regime": "bear_steepener",
  "yield_2y": 4.21,
  "yield_10y": 4.68,
  "spread_bps": 47,
  "spread_change_bps": 12,
  "days_in_regime": 9,
  "inverted": false,
  "d2y": 0.08,
  "d10y": 0.20,
  "method": "roc",
  "window": 21,
  "regimes": {
    "bull_steepener": { "label": "Bull Steepener", "color": "#166534", "description": "Both yields falling, long end faster. Risk-on, duration favoured." },
    "bear_steepener": { "label": "Bear Steepener", "color": "#991B1B", "description": "Both yields rising, long end faster. Inflation fears, commodities win." },
    "bull_flattener": { "label": "Bull Flattener", "color": "#1E3A5F", "description": "Both yields falling, short end faster. Flight to quality, late cycle." },
    "bear_flattener": { "label": "Bear Flattener", "color": "#B45309", "description": "Both yields rising, short end faster. Fed tightening, credit stress." },
    "twist_bear":     { "label": "Bear Twist",     "color": "#6B21A8", "description": "Short rising, long falling. Stagflation signal, curve confusion." },
    "twist_bull":     { "label": "Bull Twist",     "color": "#0E7490", "description": "Short falling, long rising. Easing cycle beginning, reflation." },
    "neutral":        { "label": "Neutral",         "color": "#374151", "description": "No dominant trend. Regime transition or low-volatility consolidation." }
  },
  "time_series": [
    { "date": "2024-01-01", "yield_2y": 4.43, "yield_10y": 3.97, "spread": -46, "regime": "bear_flattener" }
  ],
  "asset_heatmap": {
    "SPX": { "bull_steepener": 3.1, "bear_steepener": -0.8, "bull_flattener": 1.2, "bear_flattener": -1.9, "twist_bear": -0.4, "twist_bull": 2.2 }
  }
}
```

**Asset heatmap computation:**
- Pull 3yr daily OHLCV for SPY, TLT, GLD, BTC-USD, HYG, TIP via yfinance
- Resample to monthly returns
- Label each month with the dominant yield curve regime for that month
- Group by regime, compute mean monthly return per asset
- Return as nested dict

### Frontend: `frontend/app/yield-curve/page.tsx`

**Page layout:**

**Header row:**
- Title: "Yield Curve Regime"
- Subtitle: "2s10s steepener / flattener / twist classification · FRED daily data"
- LIVE badge
- Refresh button

**Controls row:**
- Method toggle: Rate of Change | Z-Score
- Window: 5D | 21D | 63D

**KPI strip (6 cards):**
1. Current Regime — label in regime color
2. 2Y Yield — e.g. `4.21%`
3. 10Y Yield — e.g. `4.68%`
4. Spread — e.g. `+47 bps` (red if negative/inverted)
5. Spread Δ — change in bps over window, with ▲▼ arrow
6. Days in Regime

**Inversion alert banner** (show only when `inverted: true`):
`⚠ Curve Inverted — 2Y yield exceeds 10Y. Historically precedes recession by 12–18 months.`
Style: `bg-red-900/20 border border-red-800 text-red-400`

**Regime quadrant grid (2×3, 6 cells):**
```
[ Bull Steepener ] [ Bear Steepener ]
[ Bull Flattener ] [ Bear Flattener ]
[ Bull Twist     ] [ Bear Twist     ]
```
Each cell shows: regime label (colored) + 1-line description + axis conditions footer.
Active cell: colored left border + dim background in regime color. CURRENT badge top-right.

**2Y vs 10Y yield time series chart:**
- Recharts LineChart, dual Y-axis
- Left axis: 2Y yield (blue `#38bdf8`)
- Right axis: 10Y yield (orange `#fb923c`)
- Background: ReferenceArea bands colored by regime (same pattern as Regime Matrix)
- Zero-spread ReferenceLine
- Tooltip: date + both yields + spread + regime

**2s10s Spread chart (below yield chart):**
- Single LineChart, spread in bps
- ReferenceLine at y=0
- Fill area: green above zero, red below zero (inversion)
- Regime shading bands in background
- Tooltip: date + spread bps + regime

**Asset heatmap table:**
- Rows: SPX, TLT, GLD, BTC, HYG, TIPS
- Columns: Bull Steepener | Bear Steepener | Bull Flattener | Bear Flattener | Bull Twist | Bear Twist
- Column headers in regime color
- Cells color-coded by return magnitude (same heatmap color system as Regime Matrix)
- Footer: "Avg monthly return (%) by regime · 3yr lookback · yfinance"

---

## Module 3 — STIR (existing, partial — data layer upgrade needed)

**Existing files:**
- `backend/routers/stir.py` (or inline in main.py — check)
- `frontend/app/stir/page.tsx`

**Current state:** SR3/ZQ strip uses `make_mock_strip()` with `# TODO` comments. FOMC dates hard-coded.

**Do not rebuild the frontend.** Only upgrade the data layer when CME WebSocket credentials are available. For now leave mock data in place and add a `DATA_SOURCE` env flag stub:
```python
STIR_DATA_SOURCE = os.getenv("STIR_DATA_SOURCE", "mock")  # mock | cme_websocket
```

**FRED sources already live:**
- `DFF` — EFFR
- `SOFR` — SOFR spot
- `T5YIFR` — 5y5y breakeven (shared with Regime)

---

## Module 4 — MFERM (existing, no changes)

**Existing files:** `frontend/app/mferm/page.tsx` + all backend compute logic
**Status:** Complete. Do not modify. Isolate as own tab.

---

## Data Source Registry

| Source | Series / Ticker | Module(s) | Cost | Cadence |
|---|---|---|---|---|
| FRED | `DGS2`, `DGS10` | Yield Curve | Free | Daily |
| FRED | `CPIAUCSL`, `PCEPI`, `T5YIFR`, `T10Y2Y` | Regime | Free | Monthly/Daily |
| FRED | `DFF`, `SOFR` | STIR | Free | Daily |
| yfinance | SPY, TLT, GLD, BTC-USD, HYG, TIP, DJP | Regime, Yield Curve heatmaps | Free | Daily |
| yfinance | HYG, LQD | Regime growth axis | Free | Daily |
| CME FedWatch API | FOMC probabilities | STIR Meetings tab | $25/mo | EOD |
| CME Term SOFR API | Forward SOFR curve | STIR | $25/mo | EOD |
| CME WebSocket API | SR3, ZQ futures strip | STIR | ~$1–5/mo usage | Real-time |
| CoinGecko | BTC, ETH, SOL | Correlations (future) | Free | Polling |
| Trading Economics | Economic calendar | Calendar (future) | ~$50–100/mo | Live |

**Environment variables required in `backend/.env`:**
```
FRED_API_KEY=your_key_here
STIR_DATA_SOURCE=mock
CME_API_KEY=
CME_WS_URL=
```

---

## Planned Modules (do not build yet — add greyed sidebar placeholders only)

### Correlations
- Cross-asset regression tool
- Asset universe: rates + equities (SPY, TLT) + commodities (GLD, USO) + crypto (BTC-USD, ETH-USD)
- Data: yfinance (equities/commodities) + CoinGecko (crypto)
- UI: configurable lookback, rolling correlation heatmap, scatter plot with regression line

### Calendar
- Full economic calendar with actual / estimate / prior
- Target source: Trading Economics API
- Key events: FOMC, CPI, NFP, GDP, PCE, PPI, ISM, Retail Sales
- UI: Bloomberg-style week/month view, impact filter (high/med/low), live countdown to next release

---

## Build Order for This Session

1. **Wire Regime Matrix** — register router in `main.py`, add sidebar nav item, confirm `/api/regime/snapshot` returns 200
2. **Build Yield Curve module** — create `backend/routers/yield_curve.py` + `frontend/app/yield-curve/page.tsx`, wire into `main.py` and sidebar
3. **Update sidebar** — all 6 items including greyed placeholders for Correlations and Calendar
4. **Smoke test** — both new endpoints return valid JSON, both pages render without errors, regime shading bands visible on charts
5. **Do not touch** — `frontend/app/mferm/page.tsx`, PLSR model, existing STIR frontend

---

## Notes for Claude Code

- The project path contains a space: always quote it in shell commands — `"<project root>"`
- Do not use inline `#` comments in multi-line zsh commands pasted as blocks — run commands separately
- `.venv` lives at `backend/.venv` — activate with `source backend/.venv/bin/activate` from project root
- Next.js proxies `/api/*` to FastAPI — frontend fetches `/api/regime/snapshot`, not `localhost:8000`
- Use `httpx.AsyncClient` for all FRED fetches in the backend (already in requirements)
- yfinance calls should use `progress=False` and `auto_adjust=True`
- All Recharts components: import from `"recharts"` only — no other chart libraries
- Do not add `"use client"` to server components — only add it to components that use hooks or browser APIs
- TypeScript strict mode is on — all props must be typed
- Run `npm run build` in `frontend/` after completing all changes to confirm no type errors before finishing
