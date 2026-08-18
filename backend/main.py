"""
MFERM Dashboard — FastAPI backend entrypoint.
All endpoints the Next.js frontend needs.
"""

import os
import math
from typing import Optional
from datetime import date, datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from data.asset_fetcher import validate_ticker, fetch_asset_returns
from models.attribution import compute_return_attribution, compute_point_risk, compute_rolling_risk
from models.stress import run_historical_stress, run_uncorrelated_stress, run_correlated_stress
from models.plsr import fit_plsr
from cache.simple_cache import cached_fetch
from services import model_service
from routers.regime import router as regime_router
from routers.yield_curve import router as yield_curve_router
from routers.portfolio import router as portfolio_router
from routers.rate_decomp import router as rate_decomp_router
from routers.global_rates import router as global_rates_router
from routers.cross_asset import router as cross_asset_router
from routers.fx import router as fx_router

app = FastAPI(title="MFERM Dashboard API", version="1.0.0")

app.include_router(regime_router)
app.include_router(yield_curve_router)
app.include_router(portfolio_router)
app.include_router(rate_decomp_router)
app.include_router(global_rates_router)
app.include_router(cross_asset_router)
app.include_router(fx_router)

# Comma-separated list, e.g. "https://mferm.vercel.app,https://mferm-preview.vercel.app".
# Defaults to local dev origins only — fails closed if unset in production
# rather than silently allowing everything.
ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_START = model_service.DATA_START

# TTLs (seconds)
TTL_FACTORS     = model_service.TTL_FACTORS
TTL_PLSR        = model_service.TTL_PLSR
TTL_VALIDATION  = 86400      # 24 hours
TTL_STRESS      = 4 * 3600   # same as factors

# Provenance label for factor-model-derived endpoints (attribution, risk, stress).
# Not STIR — that module carries its own per-panel source labels.
SOURCE_MODEL = "FRED + yfinance (factor model)"


def _sanitise(val):
    """Replace NaN/Inf with None for JSON serialisation."""
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return None
    return val


def _sanitise_dict(d: dict) -> dict:
    return {k: _sanitise(v) for k, v in d.items()}


# Shared helpers now live in services/model_service.py — aliased to keep
# every endpoint below unchanged.
_get_factor_matrix        = model_service.get_factor_matrix
_get_asset_returns        = model_service.get_asset_returns


# ── Asset validation ─────────────────────────────────────────────────────────

@app.get("/api/asset/validate/{ticker}")
def asset_validate(ticker: str):
    """Validate a ticker and return metadata."""
    key = f"validate_{ticker.upper()}"
    result = cached_fetch(key, TTL_VALIDATION, lambda: validate_ticker(ticker))
    if not result.get("valid"):
        raise HTTPException(
            status_code=404,
            detail={
                "error": result.get("error", "Ticker not found"),
                "code":  "INVALID_TICKER",
                "detail": f"Could not fetch data for {ticker.upper()}",
            }
        )
    return result


# ── PLSR model outputs ────────────────────────────────────────────────────────

PREFERRED_FACTOR_COLS   = model_service.PREFERRED_FACTOR_COLS
_select_factor_cols     = model_service.select_factor_cols
_exclude_currently_gapped = model_service.exclude_currently_gapped
_get_plsr               = model_service.get_plsr


@app.get("/api/model/{ticker}/exposures")
def get_exposures(ticker: str, start: str = Query("2020-01-01")):
    """Factor exposures (betas) and R² for the ticker."""
    try:
        result = _get_plsr(ticker)
        exposures = result["exposures"]
        ar = _get_asset_returns(ticker.upper(), DATA_START)
        as_of = ar.index[-1].strftime("%Y-%m-%d") if len(ar) else None
        return {
            "ticker":     ticker.upper(),
            "date":       as_of,
            "exposures":  {k: round(float(v), 6) for k, v in exposures.items()},
            "rsquared":   round(result["rsquared"], 4),
            "windowDays": result["window_days"],
            "as_of":      as_of,
            "source":     SOURCE_MODEL,
            "factors_used":    result["factors_used"],
            "factors_missing": result["factors_missing"],
            "n_factors":       result["n_factors"],
            "n_obs":           result["n_obs"],
            "first_date":      result["first_date"],
        }
    except ValueError as e:
        code = "INSUFFICIENT_DATA" if "Insufficient" in str(e) else "INVALID_TICKER"
        raise HTTPException(status_code=422, detail={
            "error": str(e), "code": code, "detail": str(e)
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "PLSR fit failed"
        })


@app.get("/api/model/{ticker}/attribution")
def get_attribution(
    ticker: str,
    start: str = Query("2024-01-01"),
    # Optional[str] = Query(None), not a computed default: FastAPI evaluates
    # a Query() default once, at import time, not per request — a literal
    # datetime.today() here freezes to whatever day the server process
    # started and never updates until restart. compute_return_attribution
    # already treats a falsy `end` as "no upper bound", which is also more
    # correct than filtering to a hardcoded "today" that may not have data
    # yet — so there's no substitute value to compute here at all.
    end: Optional[str] = Query(None),
):
    """Return attribution time series for the selected date range."""
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(ticker.upper(), DATA_START)
        result = compute_return_attribution(fm, ar, start=start, end=end,
                                             expected_factors=PREFERRED_FACTOR_COLS)
        result["as_of"] = result["dates"][-1] if result.get("dates") else None
        result["source"] = SOURCE_MODEL
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "error": str(e), "code": "INSUFFICIENT_DATA", "detail": str(e)
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Attribution failed"
        })


@app.get("/api/model/{ticker}/risk")
def get_risk(
    ticker: str,
    date: Optional[str] = Query(None),
):
    """Point-in-time risk decomposition."""
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(ticker.upper(), DATA_START)
        result = compute_point_risk(fm, ar, as_of=date,
                                     expected_factors=PREFERRED_FACTOR_COLS)
        result["ticker"] = ticker.upper()
        result["as_of"] = ar.index[-1].strftime("%Y-%m-%d") if len(ar) else None
        result["source"] = SOURCE_MODEL
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "error": str(e), "code": "INSUFFICIENT_DATA", "detail": str(e)
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Risk computation failed"
        })


@app.get("/api/model/{ticker}/rolling-risk")
def get_rolling_risk(ticker: str, roll_window: int = Query(30)):
    """Rolling vol decomposition time series."""
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(ticker.upper(), DATA_START)
        result = compute_rolling_risk(fm, ar, roll_window=roll_window,
                                       expected_factors=PREFERRED_FACTOR_COLS)
        result["as_of"] = result["dates"][-1] if result.get("dates") else None
        result["source"] = SOURCE_MODEL
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Rolling risk failed"
        })


# ── Stress testing ────────────────────────────────────────────────────────────

class HistoricalStressRequest(BaseModel):
    ticker: str
    scenario: str  # "trade_war_2018" | "covid_2020" | "rates_2022"


class UncorrelatedStressRequest(BaseModel):
    ticker: str
    shocks: dict  # factor_name → shock value (in std dev units)


class CorrelatedStressRequest(BaseModel):
    ticker:      str
    core_factor: str
    shock_value: float


@app.post("/api/stress/historical")
def stress_historical(req: HistoricalStressRequest):
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(req.ticker.upper(), DATA_START)
        result = run_historical_stress(fm, ar, req.scenario,
                                        expected_factors=PREFERRED_FACTOR_COLS)
        result["as_of"] = ar.index[-1].strftime("%Y-%m-%d") if len(ar) else None
        result["source"] = SOURCE_MODEL
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "error": str(e), "code": "INVALID_SCENARIO", "detail": str(e)
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Stress test failed"
        })


@app.post("/api/stress/uncorrelated")
def stress_uncorrelated(req: UncorrelatedStressRequest):
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(req.ticker.upper(), DATA_START)
        result = run_uncorrelated_stress(fm, ar, req.shocks,
                                          expected_factors=PREFERRED_FACTOR_COLS)
        result["as_of"] = ar.index[-1].strftime("%Y-%m-%d") if len(ar) else None
        result["source"] = SOURCE_MODEL
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Stress test failed"
        })


@app.post("/api/stress/correlated")
def stress_correlated(req: CorrelatedStressRequest):
    try:
        fm = _get_factor_matrix(DATA_START)
        cols = _select_factor_cols(fm)
        cols, _gapped = _exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = _get_asset_returns(req.ticker.upper(), DATA_START)
        result = run_correlated_stress(fm, ar, req.core_factor, req.shock_value,
                                        expected_factors=PREFERRED_FACTOR_COLS)
        result["as_of"] = ar.index[-1].strftime("%Y-%m-%d") if len(ar) else None
        result["source"] = SOURCE_MODEL
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "error": str(e), "code": "INVALID_FACTOR", "detail": str(e)
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "error": str(e), "code": "API_ERROR", "detail": "Stress test failed"
        })


# ── STIR module ───────────────────────────────────────────────────────────────
# Gated on the same flag the frontend uses (NEXT_PUBLIC_ENABLE_STIR). When
# unset, this block never executes: the route is never added to app's
# routing table (FastAPI 404s a path that was never registered — this is
# not a handler returning 404, the path genuinely doesn't exist), and
# data/stir_fetcher.py + models/stir.py are never imported, so they never
# load into the process. Excluding the .py files from the deployed
# artifact itself is a packaging-step concern for whatever Phase 4 deploy
# config ends up building the image/bundle — not achievable from here.

STIR_ENABLED = os.environ.get("NEXT_PUBLIC_ENABLE_STIR") == "true"

if STIR_ENABLED:
    TTL_STIR = 3600  # 1 hour — matches live EFFR/SOFR publication cadence

    def _strip_to_list(df) -> list[dict]:
        """Serialise a strip DataFrame to a list of dicts with JSON-safe types."""
        rows = []
        for _, row in df.iterrows():
            expiry = row["expiry"]
            rows.append({
                "symbol":       str(row["symbol"]),
                "expiry":       expiry.isoformat() if hasattr(expiry, "isoformat") else str(expiry),
                "settle":       round(float(row["settle"]), 4),
                "implied_rate": round(float(row["implied_rate"]), 4),
                "vs_ocr_bp":    round(float(row["vs_ocr_bp"]), 1),
            })
        return rows

    @app.get("/api/stir/snapshot")
    def get_stir_snapshot():
        """
        One-shot endpoint: reference rates + SOFR/FF strips + meeting path
        + spread matrix + CB-level grid.  All data the STIR tab needs.
        """
        def _build():
            from data.stir_fetcher import fetch_reference_rates, fetch_futures_strip, get_fomc_dates
            from models.stir import add_implied, find_terminal, build_meeting_path, spread_matrix, cb_levels

            today = date.today()

            # 1 — Reference rates
            ref  = fetch_reference_rates()
            effr = ref["effr"]
            sofr = ref["sofr"]

            # 2 — Futures strip
            strip, source_note = fetch_futures_strip(today, effr, sofr)
            strip = add_implied(strip, effr)

            # 3 — Split by product
            sofr_strip = strip[strip["root"] == "SR3"].reset_index(drop=True)
            ff_strip   = strip[strip["root"] == "ZQ"].reset_index(drop=True)

            # 4 — Terminal contracts
            sofr_terminal = find_terminal(sofr_strip, effr) if not sofr_strip.empty else {}
            ff_terminal   = find_terminal(ff_strip,   effr) if not ff_strip.empty   else {}

            # 5 — FOMC dates & meeting path
            fomc_dates = get_fomc_dates(today)
            path       = build_meeting_path(ff_strip, effr, fomc_dates) if not ff_strip.empty else []

            # 6 — Spread matrix on FF strip
            spreads = spread_matrix(ff_strip) if not ff_strip.empty else []

            # 7 — CB level rails
            cb_lvls = cb_levels(effr)

            return {
                "as_of":              ref["as_of"],
                "effr":               effr,
                "sofr":               sofr,
                "sofr_basis_bp":      round((sofr - effr) * 100, 1),
                "reference_rate_source": ref["source"],
                "data_source":        source_note,
                "fomc_dates":         [d.isoformat() for d in fomc_dates],
                "sr3_strip":          _strip_to_list(sofr_strip),
                "zq_strip":           _strip_to_list(ff_strip),
                "sofr_terminal_symbol": sofr_terminal.get("symbol"),
                "ff_terminal_symbol":   ff_terminal.get("symbol"),
                "meeting_path":       path,
                "spread_matrix":      spreads,
                "cb_levels":          cb_lvls,
            }

        try:
            return cached_fetch("stir_snapshot", TTL_STIR, _build)
        except Exception as e:
            raise HTTPException(status_code=500, detail={
                "error": str(e), "code": "API_ERROR", "detail": "STIR snapshot build failed"
            })


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
