"""
Regime Matrix API — backend/routers/regime.py
Drop this file into your backend/routers/ directory and register it in main.py.

Data sources:
  - FRED: CPI, PCE, 5y5y breakeven, 2s10s spread, ISM PMI proxy
  - yfinance: HYG/LQD for credit spread proxy, asset returns for heatmap
"""

from fastapi import APIRouter, HTTPException, Query
from datetime import datetime, timedelta
import httpx
import pandas as pd
import numpy as np
import yfinance as yf

from services.fred_service import fetch_fred

router = APIRouter(prefix="/api/regime", tags=["regime"])

# ── FRED series IDs ────────────────────────────────────────────────────────────
FRED_SERIES = {
    "cpi":         "CPIAUCSL",       # CPI All Urban Consumers
    "pce":         "PCEPI",          # PCE Price Index
    "breakeven_5y5y": "T5YIFR",      # 5y5y Forward Inflation Expectation
    "spread_2s10s": "T10Y2Y",        # 10Y - 2Y Treasury Spread (growth proxy)
    "ism_pmi":     "MANEMP",         # Manufacturing employment as ISM proxy
}

# Asset universe for regime heatmap
REGIME_ASSETS = {
    "SPX":   "SPY",
    "Bonds": "TLT",
    "Gold":  "GLD",
    "Cmdty": "DJP",
    "BTC":   "BTC-USD",
    "TIPS":  "TIP",
    "HY":    "HYG",
}

QUADRANTS = {
    "run_it_hot":   {"label": "Run It Hot",   "growth": "+", "inflation": "+", "color": "#B45309"},
    "stagflation":  {"label": "Stagflation",  "growth": "-", "inflation": "+", "color": "#991B1B"},
    "goldilocks":   {"label": "Goldilocks",   "growth": "+", "inflation": "-", "color": "#166534"},
    "debasement":   {"label": "Debasement",   "growth": "-", "inflation": "-", "color": "#1E3A5F"},
}


def compute_roc(series: pd.Series, window: int = 3) -> pd.Series:
    """Month-over-month rate of change, smoothed over `window` months."""
    return series.pct_change(periods=1).rolling(window).mean() * 100


def compute_zscore(series: pd.Series, window: int = 36) -> pd.Series:
    """Rolling Z-score over `window` periods."""
    roll_mean = series.rolling(window).mean()
    roll_std  = series.rolling(window).std()
    return (series - roll_mean) / roll_std.replace(0, np.nan)


def classify_regime(growth_score: float, inflation_score: float) -> str:
    if growth_score >= 0 and inflation_score >= 0:
        return "run_it_hot"
    elif growth_score < 0 and inflation_score >= 0:
        return "stagflation"
    elif growth_score >= 0 and inflation_score < 0:
        return "goldilocks"
    else:
        return "debasement"


def build_regime_series(growth: pd.Series, inflation: pd.Series) -> pd.Series:
    aligned = pd.DataFrame({"growth": growth, "inflation": inflation}).dropna()
    return aligned.apply(
        lambda row: classify_regime(row["growth"], row["inflation"]), axis=1
    )


def asset_returns_by_regime(
    regime_series: pd.Series,
    lookback_years: int = 3
) -> dict:
    """
    For each asset, compute average monthly return in each regime.
    Returns a dict: { asset_label: { regime_key: avg_pct_return } }
    """
    start = (datetime.today() - timedelta(days=lookback_years * 365)).strftime("%Y-%m-%d")
    results = {}

    for label, ticker in REGIME_ASSETS.items():
        try:
            raw = yf.download(ticker, start=start, progress=False, auto_adjust=True)
            if raw.empty:
                continue
            monthly = raw["Close"].squeeze("columns").resample("MS").last().pct_change() * 100
            monthly.index = monthly.index.to_period("M").to_timestamp()
            regime_m = regime_series.copy()
            regime_m.index = regime_m.index.to_period("M").to_timestamp()
            merged = pd.DataFrame({"ret": monthly, "regime": regime_m}).dropna()
            asset_result = {}
            for qk in QUADRANTS:
                subset = merged[merged["regime"] == qk]["ret"]
                asset_result[qk] = round(subset.mean(), 2) if not subset.empty else None
            results[label] = asset_result
        except Exception:
            results[label] = {qk: None for qk in QUADRANTS}

    return results


@router.get("/snapshot")
async def regime_snapshot(
    method: str = Query("roc", description="roc | zscore"),
    roc_window: int = Query(3, description="Smoothing window for RoC (months)"),
    zscore_window: int = Query(36, description="Rolling window for Z-score (months)"),
    market_weight: float = Query(0.4, description="Weight on market-implied signals (0–1)"),
):
    """
    Returns current regime classification, axis scores, time series history,
    and asset return heatmap by regime.
    """
    # ── Fetch FRED series ──────────────────────────────────────────────────────
    try:
        cpi        = await fetch_fred(FRED_SERIES["cpi"])
        pce        = await fetch_fred(FRED_SERIES["pce"])
        breakeven  = await fetch_fred(FRED_SERIES["breakeven_5y5y"])
        spread_2s10s = await fetch_fred(FRED_SERIES["spread_2s10s"])
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail={
            "error": str(e), "code": "FRED_ERROR", "detail": "FRED regime-series fetch failed"
        })

    # Credit spread proxy from yfinance (HYG/LQD ratio)
    try:
        # .squeeze() → Series: newer yfinance returns MultiIndex (field, ticker) columns
        hyg = yf.download("HYG", period="10y", progress=False, auto_adjust=True)["Close"].squeeze("columns").resample("MS").last()
        lqd = yf.download("LQD", period="10y", progress=False, auto_adjust=True)["Close"].squeeze("columns").resample("MS").last()
        credit_spread_proxy = (lqd / hyg).rename("credit_spread")  # rising = spreads widening = growth-
        credit_spread_proxy.index = credit_spread_proxy.index.to_period("M").to_timestamp()
    except Exception:
        credit_spread_proxy = pd.Series(dtype=float)

    # ── Build scored axes ──────────────────────────────────────────────────────
    fn = compute_roc if method == "roc" else compute_zscore
    kw = {"window": roc_window} if method == "roc" else {"window": zscore_window}

    # Inflation axis: blend CPI roc (30%), PCE roc (30%), 5y5y breakeven (40% market)
    cpi_score  = fn(cpi, **kw)
    pce_score  = fn(pce, **kw)
    be_score   = compute_zscore(breakeven, window=36)

    realised_inf = (cpi_score * 0.5 + pce_score * 0.5).dropna()
    market_inf   = be_score.dropna()
    inflation_axis = (
        realised_inf.reindex(market_inf.index).ffill() * (1 - market_weight)
        + market_inf * market_weight
    ).dropna()

    # Growth axis: blend 2s10s spread (40% market), credit spread proxy (40% market), ISM-ish (20% realised)
    spread_score  = compute_zscore(-spread_2s10s, window=36)  # invert: wider spread = slower growth
    if not credit_spread_proxy.empty:
        credit_score = compute_zscore(credit_spread_proxy, window=36)
        growth_axis = (
            spread_score.reindex(credit_score.index).ffill() * market_weight * 0.6
            + credit_score * market_weight * 0.4
        ).dropna()
    else:
        growth_axis = spread_score.dropna()

    # ── Align and classify ─────────────────────────────────────────────────────
    common_idx = growth_axis.index.intersection(inflation_axis.index)
    growth_aligned    = growth_axis.reindex(common_idx)
    inflation_aligned = inflation_axis.reindex(common_idx)

    regime_ts = build_regime_series(growth_aligned, inflation_aligned)

    current_regime    = regime_ts.iloc[-1] if not regime_ts.empty else "unknown"
    current_growth    = round(float(growth_aligned.iloc[-1]), 3)
    current_inflation = round(float(inflation_aligned.iloc[-1]), 3)

    # Days in current regime
    if len(regime_ts) > 1:
        last_change = regime_ts[regime_ts != current_regime].last_valid_index()
        if last_change:
            days_in_regime = (datetime.today() - last_change).days
        else:
            days_in_regime = (datetime.today() - regime_ts.index[0]).days
    else:
        days_in_regime = 0

    # ── Time series for charts ─────────────────────────────────────────────────
    ts_df = pd.DataFrame({
        "date":      regime_ts.index.strftime("%Y-%m-%d"),
        "growth":    growth_aligned.round(3).values,
        "inflation": inflation_aligned.round(3).values,
        "regime":    regime_ts.values,
    })

    # ── Asset heatmap ──────────────────────────────────────────────────────────
    heatmap = asset_returns_by_regime(regime_ts)

    return {
        "current_regime":    current_regime,
        "current_growth":    current_growth,
        "current_inflation": current_inflation,
        "days_in_regime":    days_in_regime,
        "growth_roc":        round(current_growth * 100, 1),
        "inflation_roc":     round(current_inflation * 100, 1),
        "method":            method,
        "quadrants":         QUADRANTS,
        "time_series":       ts_df.to_dict(orient="records"),
        "asset_heatmap":     heatmap,
        "as_of":             ts_df["date"].iloc[-1] if not ts_df.empty else None,
        "source":            "FRED (CPIAUCSL, PCEPI, T5YIFR, T10Y2Y) + yfinance (HYG, LQD)",
    }
