"""
Yield Curve Regime API — backend/routers/yield_curve.py

Classifies the 2s10s curve into steepener / flattener / twist regimes from
FRED daily Treasury yields, and computes asset returns by regime via yfinance.

Data sources:
  - FRED: DGS2 (2Y), DGS10 (10Y)
  - yfinance: SPY, TLT, GLD, BTC-USD, HYG, TIP for the regime heatmap
"""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import yfinance as yf
import httpx

from services.fred_service import fetch_fred_daily

router = APIRouter(prefix="/api/yield-curve", tags=["yield-curve"])

# Asset universe for the regime heatmap (label → yfinance ticker)
CURVE_ASSETS = {
    "SPX":  "SPY",
    "TLT":  "TLT",
    "GLD":  "GLD",
    "BTC":  "BTC-USD",
    "HY":   "HYG",
    "TIPS": "TIP",
}

REGIMES = {
    "bull_steepener": {
        "label": "Bull Steepener", "color": "#166534",
        "description": "Both yields falling, long end faster. Risk-on, duration favoured.",
    },
    "bear_steepener": {
        "label": "Bear Steepener", "color": "#991B1B",
        "description": "Both yields rising, long end faster. Inflation fears, commodities win.",
    },
    "bull_flattener": {
        "label": "Bull Flattener", "color": "#1E3A5F",
        "description": "Both yields falling, short end faster. Flight to quality, late cycle.",
    },
    "bear_flattener": {
        "label": "Bear Flattener", "color": "#B45309",
        "description": "Both yields rising, short end faster. Fed tightening, credit stress.",
    },
    "twist_bear": {
        "label": "Bear Twist", "color": "#6B21A8",
        "description": "Short rising, long falling. Stagflation signal, curve confusion.",
    },
    "twist_bull": {
        "label": "Bull Twist", "color": "#0E7490",
        "description": "Short falling, long rising. Easing cycle beginning, reflation.",
    },
    "neutral": {
        "label": "Neutral", "color": "#374151",
        "description": "No dominant trend. Regime transition or low-volatility consolidation.",
    },
}

HEATMAP_REGIMES = [
    "bull_steepener", "bear_steepener", "bull_flattener",
    "bear_flattener", "twist_bear", "twist_bull",
]

# Regime → family, for the three-curve agreement indicator
REGIME_FAMILY = {
    "bull_steepener": "steepener", "bear_steepener": "steepener",
    "bull_flattener": "flattener", "bear_flattener": "flattener",
    "twist_bull": "twist", "twist_bear": "twist",
    "neutral": "neutral",
}


def classify_yield_curve(d2y: float, d10y: float, threshold: float = 0.02) -> str:
    """Classify curve move over a window into a steepener/flattener/twist regime."""
    spread_widening = (d10y - d2y) > threshold
    spread_narrowing = (d10y - d2y) < -threshold
    both_falling = d2y < -threshold and d10y < -threshold
    both_rising = d2y > threshold and d10y > threshold

    if spread_widening and both_falling:
        return "bull_steepener"
    elif spread_widening and both_rising:
        return "bear_steepener"
    elif spread_narrowing and both_falling:
        return "bull_flattener"
    elif spread_narrowing and both_rising:
        return "bear_flattener"
    elif d2y > threshold and d10y < -threshold:
        return "twist_bear"
    elif d2y < -threshold and d10y > threshold:
        return "twist_bull"
    else:
        return "neutral"


def build_regime_frame(y2: pd.Series, y10: pd.Series, window: int, method: str) -> pd.DataFrame:
    """Aligned daily frame with yields, spread (bps), window deltas, and regime label."""
    df = pd.DataFrame({"yield_2y": y2, "yield_10y": y10}).dropna()

    if method == "zscore":
        # Z-score of the window change, scaled back into yield-change space so the
        # same bps threshold applies: sign/magnitude driven by how unusual the move is.
        d2_raw = df["yield_2y"].diff(window)
        d10_raw = df["yield_10y"].diff(window)
        z_window = max(window * 6, 63)
        d2 = (d2_raw - d2_raw.rolling(z_window).mean()) / d2_raw.rolling(z_window).std().replace(0, np.nan) * 0.10
        d10 = (d10_raw - d10_raw.rolling(z_window).mean()) / d10_raw.rolling(z_window).std().replace(0, np.nan) * 0.10
    else:
        d2 = df["yield_2y"].diff(window)
        d10 = df["yield_10y"].diff(window)

    df["d2y"] = d2
    df["d10y"] = d10
    df["spread"] = (df["yield_10y"] - df["yield_2y"]) * 100  # bps
    df["regime"] = [
        classify_yield_curve(a, b) if not (np.isnan(a) or np.isnan(b)) else "neutral"
        for a, b in zip(df["d2y"], df["d10y"])
    ]
    return df


def days_in_regime(df: pd.DataFrame) -> int:
    """Calendar days the frame's last regime has been continuously active."""
    regime_ts = df["regime"]
    current = regime_ts.iloc[-1]
    changed = regime_ts[regime_ts != current]
    if not changed.empty:
        return (df.index[-1] - changed.index[-1]).days
    return (df.index[-1] - df.index[0]).days


def curve_block(df: pd.DataFrame, prefix: str, short_key: str) -> dict:
    """
    Snapshot fields for one decomposed curve frame (same shape as the nominal
    block, prefixed). `short_key` names the short-leg field (e.g. real_5y).
    """
    last = df.iloc[-1]
    d_short = float(last["d2y"]) if not np.isnan(last["d2y"]) else 0.0
    d_long = float(last["d10y"]) if not np.isnan(last["d10y"]) else 0.0
    return {
        f"{prefix}_{short_key}": round(float(last["yield_2y"]), 2),
        f"{prefix}_10y": round(float(last["yield_10y"]), 2),
        f"{prefix}_spread_bps": round(float(last["spread"]), 1),
        f"{prefix}_spread_change_bps": round((d_long - d_short) * 100, 1),
        f"{prefix}_regime": str(last["regime"]),
        f"{prefix}_days_in_regime": days_in_regime(df),
        f"{prefix}_d{short_key}": round(d_short, 3),
        f"{prefix}_d10y": round(d_long, 3),
    }


def decomp_time_series(df: pd.DataFrame, short_key: str, tail: int = 504) -> list:
    """Chart series for a decomposed curve, honest short-leg key names."""
    return [
        {
            "date": idx.strftime("%Y-%m-%d"),
            f"yield_{short_key}": round(float(row["yield_2y"]), 3),
            "yield_10y": round(float(row["yield_10y"]), 3),
            "spread": round(float(row["spread"]), 1),
            "regime": row["regime"],
        }
        for idx, row in df.tail(tail).iterrows()
    ]


def asset_returns_by_regime(regime_daily: pd.Series, lookback_years: int = 3) -> dict:
    """
    Avg monthly return per asset per regime.
    Months are labelled with the dominant (modal) daily regime for that month.
    """
    # Dominant regime per month
    regime_monthly = regime_daily.groupby(regime_daily.index.to_period("M")).agg(
        lambda x: x.mode().iloc[0] if not x.mode().empty else "neutral"
    )
    regime_monthly.index = regime_monthly.index.to_timestamp()

    start = (datetime.today() - timedelta(days=lookback_years * 365)).strftime("%Y-%m-%d")
    results = {}

    for label, ticker in CURVE_ASSETS.items():
        try:
            raw = yf.download(ticker, start=start, progress=False, auto_adjust=True)
            if raw.empty:
                results[label] = {rk: None for rk in HEATMAP_REGIMES}
                continue
            close = raw["Close"]
            if isinstance(close, pd.DataFrame):  # yfinance MultiIndex columns
                close = close.iloc[:, 0]
            monthly = close.resample("MS").last().pct_change() * 100
            monthly.index = monthly.index.to_period("M").to_timestamp()
            merged = pd.DataFrame({"ret": monthly, "regime": regime_monthly}).dropna()
            asset_result = {}
            for rk in HEATMAP_REGIMES:
                subset = merged[merged["regime"] == rk]["ret"]
                asset_result[rk] = round(float(subset.mean()), 2) if not subset.empty else None
            results[label] = asset_result
        except Exception:
            results[label] = {rk: None for rk in HEATMAP_REGIMES}

    return results


@router.get("/snapshot")
async def yield_curve_snapshot(
    method: str = Query("roc", description="roc | zscore"),
    window: int = Query(21, ge=2, le=252, description="Lookback window in business days"),
):
    """
    Current yield curve regime, 2Y/10Y levels, spread, regime time series,
    and asset return heatmap by regime.
    """
    try:
        # All five series in parallel. NOTE: FRED has no 2Y TIPS (DFII2 does not
        # exist — series start at 5Y), so the real/inflation decomposition uses
        # 5s10s legs (DFII5/DFII10) while the nominal curve stays 2s10s.
        y2, y10, y5n, r5, r10 = await asyncio.gather(
            fetch_fred_daily("DGS2"),
            fetch_fred_daily("DGS10"),
            fetch_fred_daily("DGS5"),
            fetch_fred_daily("DFII5"),
            fetch_fred_daily("DFII10"),
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail={
            "error": str(e), "code": "FRED_ERROR", "detail": "FRED yield fetch failed"
        })

    df = build_regime_frame(y2, y10, window=window, method=method)
    if df.empty:
        raise HTTPException(status_code=500, detail={
            "error": "No yield data", "code": "NO_DATA", "detail": "FRED returned no usable observations"
        })

    last = df.iloc[-1]
    current_regime = str(last["regime"])
    spread_bps = float(last["spread"])
    d2y = float(last["d2y"]) if not np.isnan(last["d2y"]) else 0.0
    d10y = float(last["d10y"]) if not np.isnan(last["d10y"]) else 0.0

    days_in_current = days_in_regime(df)

    # ── Decomposed curves: real 5s10s + inflation 5s10s ────────────────────────
    # Inflation legs are derived per tenor (nominal − real), so the identity
    # inflation_5s10s = nominal_5s10s − real_5s10s holds exactly by construction.
    real_df = build_regime_frame(r5, r10, window=window, method=method)
    inf_short = (y5n - r5).dropna()
    inf_long = (y10 - r10).dropna()
    inf_df = build_regime_frame(inf_short, inf_long, window=window, method=method)

    if real_df.empty or inf_df.empty:
        raise HTTPException(status_code=502, detail={
            "error": "No TIPS data", "code": "NO_DATA",
            "detail": "FRED returned no usable DFII5/DFII10 observations"
        })

    real_block = curve_block(real_df, "real", "5y")
    inf_block = curve_block(inf_df, "inflation", "5y")

    # Agreement across the three curves, by regime family
    nom_family = REGIME_FAMILY.get(current_regime, "neutral")
    families = {
        "real": REGIME_FAMILY.get(real_block["real_regime"], "neutral"),
        "inflation": REGIME_FAMILY.get(inf_block["inflation_regime"], "neutral"),
    }
    divergent = [name for name, fam in families.items() if fam != nom_family]
    regime_agreement = len(divergent) == 0

    # Time series for charts — last ~2 years of daily data
    ts_df = df.tail(504)
    time_series = [
        {
            "date": idx.strftime("%Y-%m-%d"),
            "yield_2y": round(float(row["yield_2y"]), 3),
            "yield_10y": round(float(row["yield_10y"]), 3),
            "spread": round(float(row["spread"]), 1),
            "regime": row["regime"],
        }
        for idx, row in ts_df.iterrows()
    ]

    heatmap = asset_returns_by_regime(df["regime"])

    return {
        # ── Existing fields — unchanged ────────────────────────────────────────
        "as_of": df.index[-1].strftime("%Y-%m-%d"),
        "source": "FRED (DGS2, DGS5, DGS10, DFII5, DFII10) + yfinance (SPY, TLT, GLD, BTC-USD, HYG, TIP)",
        "current_regime": current_regime,
        "yield_2y": round(float(last["yield_2y"]), 2),
        "yield_10y": round(float(last["yield_10y"]), 2),
        "spread_bps": round(spread_bps, 1),
        "spread_change_bps": round((d10y - d2y) * 100, 1),
        "days_in_regime": days_in_current,
        "inverted": spread_bps < 0,
        "d2y": round(d2y, 3),
        "d10y": round(d10y, 3),
        "method": method,
        "window": window,
        "regimes": REGIMES,
        "time_series": time_series,
        "asset_heatmap": heatmap,
        # ── New: decomposed real / inflation curves (5s10s legs) ───────────────
        "decomp_short_tenor": "5Y",
        "decomp_note": (
            "Real/inflation legs use 5s10s (DFII5/DFII10): FRED publishes no "
            "2Y TIPS yield. Nominal curve remains 2s10s."
        ),
        **real_block,
        **inf_block,
        "regime_agreement": regime_agreement,
        "divergent_curves": divergent,
        "real_time_series": decomp_time_series(real_df, "5y"),
        "inflation_time_series": decomp_time_series(inf_df, "5y"),
    }
