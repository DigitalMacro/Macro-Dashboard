"""
FX Rate Differentials API — backend/routers/fx.py

Three majors against their rate anchors: spot vs short/10Y yield differentials
plus a rolling univariate OLS decomposing each pair's 20D returns into a
differential-explained part and a residual (forced to net exactly).

Legs come through the shared global-rates adapters (fetch_market_cached) — one
fetching path, one cache. US legs via shared FRED service.

Scope notes:
  - GBPUSD short leg is 5Y vs 5Y (BoE publishes no 2Y nominal series); the
    response labels this via "short_tenor". EURUSD/USDJPY use true 2Y legs.
  - GBPUSD real/inflation decomposition uses UK IUDMRZC (10Y index-linked
    real, verified live — the spec's IUDMIZC/IUDMRIZ codes are invalid) vs
    US DFII10. DE/JP real legs: no free daily source, nominal only (per spec).
"""

import asyncio
import logging
import time
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

from services.fred_service import fetch_fred_daily
from services.global_rates_service import fetch_market_cached

router = APIRouter(prefix="/api/fx", tags=["fx"])

logger = logging.getLogger("fx")

TTL_SNAPSHOT = 4 * 3600
WINDOW_2Y = 504

# base minus quote, per reference conventions
PAIRS = {
    "EURUSD": {"ticker": "EURUSD=X", "convention": "DE minus US",
               "base": "DE", "quote": "US", "short_tenor": "2Y"},
    "USDJPY": {"ticker": "USDJPY=X", "convention": "US minus JP",
               "base": "US", "quote": "JP", "short_tenor": "2Y"},
    "GBPUSD": {"ticker": "GBPUSD=X", "convention": "UK minus US",
               "base": "UK", "quote": "US", "short_tenor": "5Y"},
}

_cache: dict = {}


def _yf_close(ticker: str) -> pd.Series:
    raw = yf.download(ticker, period="3y", progress=False, auto_adjust=True)
    if raw.empty:
        raise RuntimeError(f"yfinance returned no data for {ticker}")
    close = raw["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.squeeze("columns")
    if close.index.tz is not None:
        close.index = close.index.tz_localize(None)
    return close.dropna()


def _fetch_spots() -> dict:
    """Sync yfinance fetches, bundled to run off the event loop."""
    return {name: _yf_close(cfg["ticker"]) for name, cfg in PAIRS.items()}


def _chg(s: pd.Series, n: int = 21) -> Optional[float]:
    s = s.dropna()
    if len(s) <= n:
        return None
    return float(s.iloc[-1] - s.iloc[-1 - n])


def _pct_chg(s: pd.Series, n: int = 21) -> Optional[float]:
    s = s.dropna()
    if len(s) <= n:
        return None
    return round((float(s.iloc[-1]) / float(s.iloc[-1 - n]) - 1) * 100, 2)


def rolling_ols_attribution(
    y: pd.Series, x: pd.Series, lookback: int
) -> pd.DataFrame:
    """
    Per day: beta over the trailing `lookback` (x, y) observations,
    explained = beta * x, residual = y - explained (identity forced).
    Degenerate windows (x variance ~ 0) → beta 0, residual = actual.
    """
    common = pd.DataFrame({"y": y, "x": x}).dropna()
    beta = pd.Series(np.nan, index=common.index)
    xv, yv = common["x"].values, common["y"].values
    for i in range(lookback, len(common) + 1):
        xs = xv[i - lookback:i]
        if np.std(xs) < 1e-9:
            beta.iloc[i - 1] = 0.0
        else:
            beta.iloc[i - 1] = np.polyfit(xs, yv[i - lookback:i], 1)[0]

    out = pd.DataFrame({
        "actual": common["y"],
        "beta": beta,
    })
    out["explained"] = out["beta"] * common["x"]
    out["residual"] = out["actual"] - out["explained"]  # forced identity
    return out.dropna()


def _attr_rows(attr: pd.DataFrame, tail: int = WINDOW_2Y) -> list:
    rows = []
    for d, r in attr.tail(tail).iterrows():
        expl = round(float(r["explained"]), 2)
        actual = round(float(r["actual"]), 2)
        rows.append({
            "date": d.strftime("%Y-%m-%d"),
            "actual_20d": actual,
            "explained": expl,
            "residual": round(actual - expl, 2),  # identity survives rounding
        })
    return rows


def _explained_share(attr: pd.DataFrame) -> Optional[float]:
    if attr.empty:
        return None
    last = attr.iloc[-1]
    denom = abs(last["explained"]) + abs(last["residual"])
    if denom == 0:
        return None
    return round(abs(last["explained"]) / denom * 100)


def _build_pair(
    name: str, cfg: dict, spot: pd.Series,
    legs: dict, ols_lookback: int, ret_window: int,
    uk_real_10y: Optional[pd.Series], us_real_10y: Optional[pd.Series],
) -> tuple:
    """Returns (pair_dict, spot_series_rows)."""
    short = cfg["short_tenor"]
    base, quote = legs[cfg["base"]], legs[cfg["quote"]]

    idx = spot.index
    b_s = base[short].reindex(idx).ffill(limit=3)
    q_s = quote[short].reindex(idx).ffill(limit=3)
    b_l = base["10Y"].reindex(idx).ffill(limit=3)
    q_l = quote["10Y"].reindex(idx).ffill(limit=3)

    diff_s = (b_s - q_s).dropna()   # percentage points
    diff_l = (b_l - q_l).dropna()

    if diff_s.empty or diff_l.empty:
        raise RuntimeError(f"{name}: empty differential series")

    # Rolling OLS: y = 20D log return (%), x = 20D differential change (bp)
    y = (np.log(spot / spot.shift(ret_window)) * 100).dropna()
    x_s = (diff_s.diff(ret_window) * 100).dropna()
    x_l = (diff_l.diff(ret_window) * 100).dropna()
    attr_s = rolling_ols_attribution(y, x_s, ols_lookback)
    attr_l = rolling_ols_attribution(y, x_l, ols_lookback)

    share_s = _explained_share(attr_s)
    share_l = _explained_share(attr_l)
    driver_tenor = None
    if share_s is not None and share_l is not None:
        driver_tenor = short if share_s >= share_l else "10Y"

    pair = {
        "spot": round(float(spot.iloc[-1]), 4),
        "spot_1m_pct": _pct_chg(spot),
        "convention": cfg["convention"],
        "short_tenor": short,
        "diff_2y_bp": round(float(diff_s.iloc[-1]) * 100, 0),
        "diff_2y_1m_chg": round(_chg(diff_s) * 100, 0) if _chg(diff_s) is not None else None,
        "diff_10y_bp": round(float(diff_l.iloc[-1]) * 100, 0),
        "diff_10y_1m_chg": round(_chg(diff_l) * 100, 0) if _chg(diff_l) is not None else None,
        "attribution_2y": _attr_rows(attr_s),
        "attribution_10y": _attr_rows(attr_l),
        "current": {
            "driver_tenor": driver_tenor,
            "explained_share_2y": share_s,
            "explained_share_10y": share_l,
            "beta_2y": round(float(attr_s["beta"].iloc[-1]), 4) if not attr_s.empty else None,
            "beta_10y": round(float(attr_l["beta"].iloc[-1]), 4) if not attr_l.empty else None,
        },
        "decomposition": None,
    }

    # GBPUSD-only real/inflation decomposition (10Y legs; identity forced)
    if name == "GBPUSD" and uk_real_10y is not None and us_real_10y is not None:
        ukr = uk_real_10y.reindex(idx).ffill(limit=3)
        usr = us_real_10y.reindex(idx).ffill(limit=3)
        frame = pd.DataFrame({
            "nom": b_l - q_l,
            "real": ukr - usr,
        }).dropna()
        if not frame.empty:
            frame["inf"] = frame["nom"] - frame["real"]  # identity
            real_series = []
            for d, r in frame.tail(WINDOW_2Y).iterrows():
                real_bp = round(float(r["real"]) * 100, 0)
                inf_bp = round(float(r["nom"] - r["real"]) * 100, 0)
                real_series.append({
                    "date": d.strftime("%Y-%m-%d"),
                    "real_diff": real_bp,
                    "inf_diff": inf_bp,
                    "nom_diff": real_bp + inf_bp,  # nets exactly
                })
            real_1m = _chg(frame["real"])
            inf_1m = _chg(frame["inf"])
            driver_leg, driver_pct = None, None
            if real_1m is not None and inf_1m is not None:
                total = abs(real_1m) + abs(inf_1m)
                if total > 0:
                    if abs(real_1m) >= abs(inf_1m):
                        driver_leg = "REAL"
                        driver_pct = round(abs(real_1m) / total * 100)
                    else:
                        driver_leg = "INFLATION"
                        driver_pct = round(abs(inf_1m) / total * 100)
            pair["decomposition"] = {
                "real_leg_tenor": "10Y",
                "real_source": "BoE IUDMRZC vs FRED DFII10",
                "real_diff_10y_bp": round(float(frame["real"].iloc[-1]) * 100, 0),
                "real_diff_1m_chg": round(real_1m * 100, 0) if real_1m is not None else None,
                "inf_diff_10y_bp": round(float(frame["inf"].iloc[-1]) * 100, 0),
                "inf_diff_1m_chg": round(inf_1m * 100, 0) if inf_1m is not None else None,
                "driver_leg_1m": driver_leg,
                "driver_leg_pct": driver_pct,
                "real_series": real_series,
            }

    spot_rows = [
        {
            "date": d.strftime("%Y-%m-%d"),
            "spot": round(float(spot.loc[d]), 4),
            "diff_2y": round(float(diff_s.loc[d]) * 100, 0) if d in diff_s.index else None,
            "diff_10y": round(float(diff_l.loc[d]) * 100, 0) if d in diff_l.index else None,
        }
        for d in idx[-WINDOW_2Y:]
    ]
    return pair, spot_rows


async def _build_snapshot(ols_lookback: int, ret_window: int) -> dict:
    # Spots off the event loop (yfinance is sync and can stall when limited)
    spots = await asyncio.to_thread(_fetch_spots)

    # US legs via shared FRED service; DE/UK/JP via shared market adapters
    us_2y, us_5y, us_10y, us_real_10y = await asyncio.gather(
        fetch_fred_daily("DGS2", 1200),
        fetch_fred_daily("DGS5", 1200),
        fetch_fred_daily("DGS10", 1200),
        fetch_fred_daily("DFII10", 1200),
    )
    legs = {"US": {"2Y": us_2y, "5Y": us_5y, "10Y": us_10y}}

    uk_real_10y = None
    market_errors = {}
    for code in ("DE", "UK", "JP"):
        try:
            data = await fetch_market_cached(code, lookback_days=900)
            legs[code] = data["history"]
            if code == "UK":
                uk_real_10y = data.get("real_history", {}).get("10Y")
        except Exception as e:
            logger.exception("FX leg adapter %s failed: %s", code, e)
            market_errors[code] = str(e)

    pairs, spot_series, failed = {}, {}, []
    for name, cfg in PAIRS.items():
        try:
            if cfg["base"] not in legs or cfg["quote"] not in legs:
                raise RuntimeError(f"missing market leg for {name}")
            pair, rows = _build_pair(
                name, cfg, spots[name], legs, ols_lookback, ret_window,
                uk_real_10y, us_real_10y,
            )
            pairs[name] = pair
            spot_series[name] = rows
        except Exception as e:
            logger.exception("FX pair %s failed: %s", name, e)
            failed.append(name)

    if not pairs:
        raise HTTPException(status_code=502, detail={
            "error": "All FX pairs failed", "code": "ALL_PAIRS_DOWN",
            "detail": f"failed: {failed}; market errors: {market_errors}",
        })

    pair_last_dates = [rows[-1]["date"] for rows in spot_series.values() if rows]
    return {
        "as_of": max(pair_last_dates) if pair_last_dates else None,
        "source": "yfinance (spot FX) + FRED/national sources (rate legs)",
        "ols_lookback": ols_lookback,
        "ret_window": ret_window,
        "failed_pairs": failed,
        "pairs": pairs,
        "spot_series": spot_series,
    }


@router.get("/snapshot")
async def fx_snapshot(
    ols_lookback: int = Query(20, ge=5, le=63),
    ret_window: int = Query(20, ge=5, le=63),
):
    key = (ols_lookback, ret_window)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[1] < TTL_SNAPSHOT:
        return hit[0]
    snap = await _build_snapshot(ols_lookback, ret_window)
    if not snap["failed_pairs"]:
        _cache[key] = (snap, now)
    return snap
