# MFERM Dashboard — Module Addition: Portfolio Risk Overlay
**Append to existing DASHBOARD_SPEC.md context. All design system tokens, stack constraints, and conventions from the main spec apply.**

**Project path:** `<project root>`
**Files to create:**
- `backend/routers/portfolio.py`
- `backend/db/portfolio_store.py` (SQLite persistence)
- `frontend/app/portfolio/page.tsx`

**Wire into:**
- `backend/main.py`: register portfolio router
- Sidebar: add "Portfolio" nav item → `/portfolio`, positioned after MFERM, before Regime Matrix

---

## Purpose

Track a mock long/short portfolio with real market prices, per-position P&L from entry, aggregate factor exposures via the existing MFERM PLSR model, and benchmark-relative performance vs SPY. This is a paper-trading proof-of-concept book: positions are entered manually, marked to market daily via yfinance, and decomposed through the existing factor infrastructure.

---

## Persistence Layer — `backend/db/portfolio_store.py`

SQLite database at `backend/db/portfolio.db` (create `db/` directory; add `portfolio.db` to `.gitignore`).

**Table: positions**
```sql
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long', 'short')),
    weight REAL NOT NULL,              -- percent of book, e.g. 5.0 = 5%
    entry_date TEXT NOT NULL,          -- ISO date
    entry_price REAL,                  -- fetched on creation, nullable until resolved
    exit_date TEXT,                    -- NULL while open
    exit_price REAL,                   -- NULL while open
    thesis TEXT,                       -- optional one-line rationale
    created_at TEXT DEFAULT (datetime('now'))
);
```

Store module exposes: `add_position()`, `close_position(id, exit_date)`, `delete_position(id)`, `get_open_positions()`, `get_closed_positions()`, `get_all_positions()`.

**Entry price resolution:** on position creation, fetch the closing price for `entry_date` via yfinance. If entry_date is today and market is open, use latest available price. If the date is a non-trading day, use the next trading day's close and store that as the effective entry. Never leave entry_price NULL after creation succeeds — fail the request with a 422 if the price can't be resolved.

---

## Backend — `backend/routers/portfolio.py`

**Router prefix:** `/api/portfolio`

### Endpoints

**`POST /api/portfolio/positions`**
Body: `{ ticker, side, weight, entry_date, thesis? }`
Validates ticker via existing `validate_ticker()` from `data.asset_fetcher`. Resolves entry price. Returns created position.
Validation rules:
- weight > 0 and ≤ 25 (no single position over 25% of book)
- Sum of open position weights must not exceed 200 (gross exposure cap, allows 100 long / 100 short)
- entry_date not in the future

**`DELETE /api/portfolio/positions/{id}`** — remove a position entirely (data entry mistakes)

**`POST /api/portfolio/positions/{id}/close`**
Body: `{ exit_date }` — resolves exit price same way as entry, marks position closed. Closed positions keep contributing to realized P&L history.

**`GET /api/portfolio/snapshot`**
The main endpoint. Returns everything the frontend needs in one call:

```json
{
  "as_of": "2026-07-16",
  "positions": [
    {
      "id": 1, "ticker": "NVDA", "side": "long", "weight": 8.0,
      "entry_date": "2026-07-01", "entry_price": 172.40,
      "current_price": 181.22, "pnl_pct": 5.12, "pnl_contribution_bps": 41.0,
      "status": "open", "thesis": "AI capex supercycle"
    }
  ],
  "summary": {
    "gross_exposure": 145.0,
    "net_exposure": 35.0,
    "long_exposure": 90.0,
    "short_exposure": 55.0,
    "n_open": 8,
    "n_closed": 3,
    "total_pnl_bps": 128.4,
    "realized_pnl_bps": 22.1,
    "unrealized_pnl_bps": 106.3,
    "spy_return_since_inception_pct": 2.31,
    "portfolio_return_pct": 1.28,
    "active_return_pct": -1.03
  },
  "pnl_series": [
    { "date": "2026-07-01", "portfolio_cum_bps": 0, "spy_cum_pct": 0 }
  ],
  "factor_exposures": {
    "economic_growth": 0.42, "inflation": -0.18, "...": 0
  },
  "factor_pnl_attribution": {
    "economic_growth": 31.2, "inflation": -8.4, "residual": 42.1
  },
  "regime_context": { "current_regime": "stagflation", "regime_consistency_score": -0.3 }
}
```

### Computation details

**Per-position P&L:**
- Long: `pnl_pct = (current_price / entry_price - 1) * 100`
- Short: `pnl_pct = (entry_price / current_price - 1) * 100` — note this is the correct short P&L convention (price falling = positive P&L), computed on price ratio, not negated long P&L
- Contribution: `pnl_contribution_bps = pnl_pct * weight` (weight in %, so 5% position up 2% = 10bps of book)
- Closed positions use exit_price instead of current_price

**Portfolio P&L series:**
- Daily series from earliest entry_date to today
- Each day: sum of per-position contributions for positions open that day, using daily closes from yfinance (batch download all tickers once, cache with TTL 1 hour)
- SPY benchmark series over the same date range, rebased to 0 at the portfolio's earliest entry date

**Aggregate factor exposures:**
- For each open position, get factor betas from existing `_get_plsr(ticker)` logic — import and reuse `fit_plsr`, `_get_factor_matrix`, `_get_asset_returns` patterns from main.py (refactor these helpers into a shared module `backend/services/model_service.py` if cleaner, but do not change their behavior)
- Portfolio beta per factor = Σ (signed_weight_i × beta_i) where signed_weight is +weight/100 for longs, −weight/100 for shorts
- If a ticker's PLSR fit fails (insufficient data), exclude it from factor aggregation and include a `factor_coverage_pct` field in summary showing what % of gross exposure is factor-modeled

**Factor P&L attribution:**
- Using each position's factor betas and the daily factor returns from the factor matrix: attributed P&L per factor = Σ over days Σ over positions (signed_weight × beta_factor × factor_return_day), in bps
- Residual = total P&L − Σ factor-attributed P&L

**Regime consistency score:**
- Fetch current regime from the regime module's classification logic (import the classification, don't duplicate)
- Score = correlation between the portfolio's net factor tilts and the historically best-performing factor tilts for the current regime, normalized to [-1, 1]
- Simple implementation: for the current regime, rank the asset heatmap returns; score positively if the portfolio is net long assets that historically outperform in this regime and net short those that underperform
- Display as a simple gauge: "Regime Consistent" (> 0.3), "Regime Neutral" (−0.3 to 0.3), "Regime Contrarian" (< −0.3)

---

## Frontend — `frontend/app/portfolio/page.tsx`

Follow the established design system exactly (dark surface cards, mono labels, amber accents).

**Header row:** Title "Portfolio — L/S Book" + LIVE badge + Refresh + "Add Position" button (amber, prominent)

**Add Position modal/panel:**
- Fields: Ticker (text, uppercase, validated on blur via `/api/asset/validate/{ticker}`), Side (Long/Short toggle — green/red), Weight (% number input), Entry Date (date picker, default today), Thesis (optional text)
- Submit → POST, refresh snapshot
- Show validation errors inline (invalid ticker, weight cap, gross exposure cap)

**KPI strip (6 cards):**
1. Total P&L — bps, green/red
2. vs SPY — active return %, green/red
3. Gross Exposure — %
4. Net Exposure — % (with L/S split as sub-label, e.g. "90L / 55S")
5. Open Positions — count
6. Regime Fit — "Consistent / Neutral / Contrarian" in regime-appropriate color

**P&L chart:**
- Recharts LineChart: portfolio cumulative bps (amber line) vs SPY cumulative % (muted gray line), dual axis
- Regime shading bands in background (reuse the pattern from Regime Matrix — fetch regime time series)

**Positions table:**
- Columns: Ticker | Side (L/S pill, green/red) | Weight | Entry Date | Entry Px | Current Px | P&L % | Contrib (bps) | Thesis | Actions (Close / Delete)
- Sort by contribution descending
- Closed positions in a collapsed section below, muted styling
- Short positions: P&L colored by actual P&L sign (a short that's down in price shows green)

**Factor exposure panel (2-col grid):**
- Left: horizontal bar chart of net factor betas (12 factors), positive bars blue, negative orange, sorted by absolute magnitude
- Right: factor P&L attribution — same layout but showing attributed bps per factor, plus residual

**Empty state:** if no positions, show a centered card: "No positions yet. Add your first L/S position to start tracking." with the Add Position button.

---

## Build Order

1. Create `backend/db/portfolio_store.py` with SQLite schema and CRUD
2. Create `backend/routers/portfolio.py` with all endpoints; refactor shared PLSR helpers into `backend/services/model_service.py` and update main.py imports (behavior unchanged)
3. Register router in `main.py`
4. Build `frontend/app/portfolio/page.tsx`
5. Add sidebar nav item
6. Smoke test: add 3 test positions (1 long, 1 short, 1 with an old entry date), verify P&L math manually against yfinance prices, verify short P&L sign convention, then delete test positions
7. `npm run build` — zero type errors

## Notes for Claude Code

- Reuse existing cache (`cache.simple_cache.cached_fetch`) for price fetches — TTL 3600
- Batch yfinance downloads: one `yf.download(tickers_list)` call per snapshot, not per-position calls
- yfinance MultiIndex columns: use `.squeeze("columns")` pattern already established in regime.py
- Weekend/holiday entry dates: resolve to next trading day close, return effective date in response
- All FRED/model imports already exist — do not re-implement PLSR
- SQLite connection: use a module-level connection with `check_same_thread=False` or per-request connections; keep it simple, this is single-user
