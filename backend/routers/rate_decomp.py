"""
Rate Decomposition API — backend/routers/rate_decomp.py

Decomposes nominal Treasury yields into real (TIPS) + inflation swap
(breakeven) components. This is an exact identity, not a model fit:
    nominal = real + inflation_swap
Inflation is always DERIVED as nominal − real so the identity holds at
every data point by construction.
"""

import asyncio
import time
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from services.fred_service import fetch_fred_daily

router = APIRouter(prefix="/api/rate-decomp", tags=["rate-decomp"])

# NOTE: the spec's 2Y tenor is impossible from FRED — DFII2 does not exist
# (TIPS constant-maturity yields start at 5Y, same reason there is no 1Y).
# Per the spec's own fallback rule ("skip for now, add later via Cleveland Fed
# interpolation"), the short tenor is 5Y and the curve decomp is 5s30s.
TENORS = ["5Y", "7Y", "10Y", "30Y"]
NOMINAL_SERIES = {"5Y": "DGS5", "7Y": "DGS7", "10Y": "DGS10", "30Y": "DGS30"}
REAL_SERIES    = {"5Y": "DFII5", "7Y": "DFII7", "10Y": "DFII10", "30Y": "DFII30"}
SHORT_TENOR, LONG_TENOR = "5Y", "30Y"  # curve decomposition legs

FETCH_DAYS = 830          # ~2y of sessions + buffer for 21d windows
TTL_SERIES = 4 * 3600     # 4h, same as existing factor data

LOOKBACK_SESSIONS = {"1m": 21, "3m": 63, "6m": 126, "1y": 252, "2y": 504}
ROLL_WINDOWS = (5, 10, 21)

# Module-level cache for the assembled yield frame (async fetch → manual TTL)
_frame_cache: dict = {"df": None, "ts": 0.0}


async def _get_yield_frame() -> pd.DataFrame:
    """
    Daily frame with columns nom_<T> and real_<T> for each tenor,
    all 8 FRED series fetched in parallel, cached 4h.
    """
    now = time.time()
    if _frame_cache["df"] is not None and now - _frame_cache["ts"] < TTL_SERIES:
        return _frame_cache["df"]

    sids = [NOMINAL_SERIES[t] for t in TENORS] + [REAL_SERIES[t] for t in TENORS]
    results = await asyncio.gather(*[fetch_fred_daily(s, FETCH_DAYS) for s in sids])

    cols = {}
    for t, s in zip(TENORS, results[: len(TENORS)]):
        cols[f"nom_{t}"] = s
    for t, s in zip(TENORS, results[len(TENORS):]):
        cols[f"real_{t}"] = s

    df = pd.DataFrame(cols).dropna(how="all").sort_index()
    if df.empty:
        raise HTTPException(status_code=502, detail={
            "error": "FRED returned no data", "code": "NO_DATA",
            "detail": "All rate-decomp series came back empty",
        })
    _frame_cache["df"] = df
    _frame_cache["ts"] = now
    return df


def _driver(real_chg: float, inf_chg: float) -> tuple:
    """(label, pct) — which leg drove the move, and its share of total |change|."""
    total = abs(real_chg) + abs(inf_chg)
    if total == 0:
        return "NEUTRAL", None
    real_share = abs(real_chg) / total * 100.0
    if abs(real_chg) >= abs(inf_chg):
        return "REAL", round(real_share, 1)
    return "INFLATION", round(100.0 - real_share, 1)


def _tenor_frame(df: pd.DataFrame, tenor: str) -> pd.DataFrame:
    """Aligned nominal/real/inflation frame for one tenor (identity enforced)."""
    sub = df[[f"nom_{tenor}", f"real_{tenor}"]].dropna()
    out = pd.DataFrame({
        "nominal": sub[f"nom_{tenor}"],
        "real": sub[f"real_{tenor}"],
    })
    out["inflation"] = out["nominal"] - out["real"]  # exact identity
    return out


def _chg_bps(series: pd.Series, sessions: int) -> Optional[float]:
    """Change vs `sessions` rows ago, in bps. None if not enough history."""
    if len(series) <= sessions:
        return None
    return float((series.iloc[-1] - series.iloc[-1 - sessions]) * 100.0)


def _tenor_snapshot(tf: pd.DataFrame) -> dict:
    nom_chg = _chg_bps(tf["nominal"], 21) or 0.0
    real_chg = _chg_bps(tf["real"], 21) or 0.0
    inf_chg = nom_chg - real_chg  # identity in change space
    label, pct = _driver(real_chg, inf_chg)
    return {
        "nominal": round(float(tf["nominal"].iloc[-1]), 2),
        "real": round(float(tf["real"].iloc[-1]), 2),
        "inflation_swap": round(float(tf["inflation"].iloc[-1]), 2),
        "nominal_1m_chg": round(nom_chg, 1),
        "real_1m_chg": round(real_chg, 1),
        "inflation_1m_chg": round(inf_chg, 1),
        "driver_1m": label,
        "driver_1m_pct": pct,
    }


def _rolling_attribution(tf: pd.DataFrame, roll: int, tail: int) -> list:
    """
    Rolling `roll`-day changes in bps, identity enforced after rounding:
    round real, derive inflation from raw nominal−real then round, and
    republish nominal as the sum so bars and line agree exactly.
    """
    nom_chg = tf["nominal"].diff(roll) * 100.0
    real_chg = tf["real"].diff(roll) * 100.0
    frame = pd.DataFrame({"nom": nom_chg, "real": real_chg}).dropna().tail(tail)

    rows = []
    for d, row in frame.iterrows():
        real_r = round(float(row["real"]), 1)
        inf_r = round(float(row["nom"] - row["real"]), 1)
        rows.append({
            "date": d.strftime("%Y-%m-%d"),
            "nominal_chg": round(real_r + inf_r, 1),
            "real_chg": real_r,
            "inflation_chg": inf_r,
        })
    return rows


def _quadrant_label(real_leg: float, inf_leg: float) -> str:
    if real_leg >= 0 and inf_leg >= 0:
        return "BOTH STEEPEN"
    if real_leg < 0 and inf_leg >= 0:
        return "INF STEEPENS · REAL FLATTENS"
    if real_leg >= 0 and inf_leg < 0:
        return "REAL STEEPENS · INF FLATTENS"
    return "BOTH FLATTEN"


@router.get("/snapshot")
async def rate_decomp_snapshot(
    lookback: str = Query("1y", description="1m | 3m | 6m | 1y | 2y"),
    roll_window: int = Query(10, description="Rolling change window: 5 | 10 | 21"),
):
    if lookback not in LOOKBACK_SESSIONS:
        raise HTTPException(status_code=422, detail={
            "error": f"lookback must be one of {sorted(LOOKBACK_SESSIONS)}",
            "code": "INVALID_LOOKBACK", "detail": f"got {lookback}",
        })
    if roll_window not in ROLL_WINDOWS:
        raise HTTPException(status_code=422, detail={
            "error": f"roll_window must be one of {ROLL_WINDOWS}",
            "code": "INVALID_WINDOW", "detail": f"got {roll_window}",
        })
    tail = LOOKBACK_SESSIONS[lookback]

    df = await _get_yield_frame()
    tenor_frames = {t: _tenor_frame(df, t) for t in TENORS}
    for t, tf in tenor_frames.items():
        if tf.empty:
            raise HTTPException(status_code=502, detail={
                "error": f"No data for tenor {t}", "code": "NO_DATA",
                "detail": f"FRED series {NOMINAL_SERIES[t]}/{REAL_SERIES[t]} empty",
            })

    # 1 — Per-tenor snapshots
    tenors = {t: _tenor_snapshot(tf) for t, tf in tenor_frames.items()}

    # 2 — Curve complex (today vs 21 sessions ago)
    def _ago(series: pd.Series, n: int = 21) -> float:
        return float(series.iloc[-1 - n]) if len(series) > n else float(series.iloc[0])

    curve_complex = {
        "tenors": TENORS,
        "nominal_today": [tenors[t]["nominal"] for t in TENORS],
        "nominal_1m_ago": [round(_ago(tenor_frames[t]["nominal"]), 2) for t in TENORS],
        "real_today": [tenors[t]["real"] for t in TENORS],
        "real_1m_ago": [round(_ago(tenor_frames[t]["real"]), 2) for t in TENORS],
        "inflation_today": [tenors[t]["inflation_swap"] for t in TENORS],
        "inflation_1m_ago": [
            round(_ago(tenor_frames[t]["nominal"]) - _ago(tenor_frames[t]["real"]), 2)
            for t in TENORS
        ],
    }

    # 3 — Rolling attribution for the short tenor (5Y) and 10Y
    attribution_short = _rolling_attribution(tenor_frames[SHORT_TENOR], roll_window, tail)
    attribution_10y = _rolling_attribution(tenor_frames["10Y"], roll_window, tail)

    # 4 — 5s30s decomposition (identity: nominal spread = real leg + inflation leg)
    joined = tenor_frames[SHORT_TENOR].join(
        tenor_frames[LONG_TENOR], lsuffix="_s", rsuffix="_l"
    ).dropna()
    spread = pd.DataFrame({
        "nominal": joined["nominal_l"] - joined["nominal_s"],
        "real": joined["real_l"] - joined["real_s"],
    })
    spread["inflation"] = spread["nominal"] - spread["real"]

    s_nom_chg = _chg_bps(spread["nominal"], 21) or 0.0
    s_real_chg = _chg_bps(spread["real"], 21) or 0.0
    s_inf_chg = s_nom_chg - s_real_chg
    s_label, s_pct = _driver(s_real_chg, s_inf_chg)

    spread_ts = [
        {
            "date": r["date"],
            "nominal_chg": r["nominal_chg"],
            "real_leg": r["real_chg"],
            "inflation_leg": r["inflation_chg"],
        }
        for r in _rolling_attribution(spread, roll_window, tail)
    ]

    curve_decomp = {
        "short_tenor": SHORT_TENOR,
        "long_tenor": LONG_TENOR,
        "nominal_spread": round(float(spread["nominal"].iloc[-1]) * 100.0, 1),
        "real_spread": round(float(spread["real"].iloc[-1]) * 100.0, 1),
        "inflation_spread": round(float(spread["inflation"].iloc[-1]) * 100.0, 1),
        "nominal_1m_chg": round(s_nom_chg, 1),
        "real_leg_1m_chg": round(s_real_chg, 1),
        "inflation_leg_1m_chg": round(s_inf_chg, 1),
        "driver": s_label,
        "driver_pct": s_pct,
        "time_series": spread_ts,
    }

    # 5 — Curve leg quadrant (21D leg changes, 60-session trail)
    real_leg_21 = spread["real"].diff(21) * 100.0
    nom_21 = spread["nominal"].diff(21) * 100.0
    quad = pd.DataFrame({"real_leg": real_leg_21, "nom": nom_21}).dropna()
    quad["inf_leg"] = quad["nom"] - quad["real_leg"]
    quad = quad.tail(60)

    if quad.empty:
        quadrant = {"current": None, "trail": []}
    else:
        cur_real = round(float(quad["real_leg"].iloc[-1]), 1)
        cur_inf = round(float(quad["inf_leg"].iloc[-1]), 1)
        quadrant = {
            "current": {
                "real_leg_21d": cur_real,
                "inf_leg_21d": cur_inf,
                "label": _quadrant_label(cur_real, cur_inf),
            },
            "trail": [
                {
                    "date": d.strftime("%Y-%m-%d"),
                    "real_leg_21d": round(float(r["real_leg"]), 1),
                    "inf_leg_21d": round(float(r["inf_leg"]), 1),
                }
                for d, r in quad.iterrows()
            ],
        }

    return {
        "as_of": df.index[-1].strftime("%Y-%m-%d") if len(df) else None,
        "source": "FRED (DGS5/DGS7/DGS10/DGS30, DFII5/DFII7/DFII10/DFII30)",
        "tenor_note": (
            "2Y omitted: FRED publishes no 2Y TIPS constant-maturity yield "
            "(DFII2 does not exist). Shortest daily real tenor is 5Y; curve "
            "decomposition is 5s30s."
        ),
        "tenors": tenors,
        "headline": {"tenor": "10Y", **tenors["10Y"]},
        "curve_complex": curve_complex,
        "attribution_short": attribution_short,
        "attribution_10y": attribution_10y,
        "curve_decomp": curve_decomp,
        "quadrant": quadrant,
    }
