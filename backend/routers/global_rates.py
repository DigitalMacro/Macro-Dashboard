"""
Global Rates API — backend/routers/global_rates.py

Four rates markets side by side (US, DE, UK, JP) via per-market adapters in
services/global_rates_service.py. Market-agnostic compute: slope, 1M changes,
normalized 10Y overlay, and curve regime classification reusing the existing
yield-curve framework. One market's source failure never 500s the endpoint.
"""

import logging
import time
from datetime import date

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from routers.yield_curve import build_regime_frame, days_in_regime
from services.global_rates_service import MARKETS, fetch_market_cached

router = APIRouter(prefix="/api/global-rates", tags=["global-rates"])

logger = logging.getLogger("global_rates")

TTL_SNAPSHOT = 4 * 3600  # daily-close data — no benefit to shorter

# Manual async snapshot cache, keyed by window (cached_fetch is sync-only)
_cache: dict = {}


def _chg_bps(s: pd.Series, sessions: int) -> float | None:
    s = s.dropna()
    if len(s) <= sessions:
        return None
    return round(float(s.iloc[-1] - s.iloc[-1 - sessions]) * 100, 1)


def _build_market(code: str, cfg: dict, data: dict, window: int) -> dict:
    history = data["history"]
    tenors = data["tenors"]
    short = cfg["short_tenor"]

    y_short = history.get(short, pd.Series(dtype=float)).dropna()
    y10 = history.get("10Y", pd.Series(dtype=float)).dropna()
    if y_short.empty or y10.empty:
        raise RuntimeError(f"{code}: missing {short} or 10Y history")

    # Regime classification on short/10Y using the existing framework
    frame = build_regime_frame(y_short, y10, window=window, method="roc")
    regime = str(frame["regime"].iloc[-1]) if not frame.empty else "neutral"
    days = days_in_regime(frame) if not frame.empty else 0

    slope_bps = round((tenors["10Y"] - tenors[short]) * 100, 1)

    # Normalized 10Y over the trailing 1Y window — per-market min/max, never global
    y10_1y = y10.tail(252)
    lo, hi = float(y10_1y.min()), float(y10_1y.max())
    rng = hi - lo
    overlay = [
        {
            "date": d.strftime("%Y-%m-%d"),
            "normalized": round((float(v) - lo) / rng, 4) if rng > 0 else 0.5,
            "raw": round(float(v), 3),
        }
        for d, v in y10_1y.items()
    ]

    tenor_order = [t for t in ["2Y", "5Y", "10Y", "20Y", "30Y"] if t in tenors]
    return {
        "name": cfg["name"],
        "color": cfg["color"],
        "policy_rate": data.get("policy_rate"),
        "policy_rate_manual": data.get("policy_rate_manual", False),
        "policy_label": cfg["policy_label"],
        "source": data.get("source"),
        "as_of": data.get("as_of"),
        "short_tenor": short,
        "slope_label": f"{short.lower().replace('y', '')}s10s",
        "tenors": tenors,
        "changes_1m_bps": {t: _chg_bps(history[t], 21) for t in tenor_order if t in history},
        "slope_2s10s_bps": slope_bps,
        "regime": regime,
        "days_in_regime": days,
        "curve_snapshot": {
            "tenors": tenor_order,
            "yields": [tenors[t] for t in tenor_order],
        },
        "overlay_10y": overlay,
    }


async def _build_snapshot(window: int) -> dict:
    markets: dict = {}
    failed: list = []

    for code, cfg in MARKETS.items():
        try:
            raw = await fetch_market_cached(code)
            markets[code] = _build_market(code, cfg, raw, window)
        except Exception as e:
            logger.exception("Global rates adapter %s failed: %s", code, e)
            failed.append(code)

    if not markets:
        raise HTTPException(status_code=502, detail={
            "error": "All market adapters failed", "code": "ALL_SOURCES_DOWN",
            "detail": f"failed: {failed}",
        })

    ranking = sorted(
        [{"market": c, "slope_bps": m["slope_2s10s_bps"], "slope_label": m["slope_label"]}
         for c, m in markets.items()],
        key=lambda r: r["slope_bps"], reverse=True,
    )

    riser = None
    risers = {
        c: m["changes_1m_bps"].get("10Y")
        for c, m in markets.items()
        if m["changes_1m_bps"].get("10Y") is not None
    }
    if risers:
        riser = max(risers, key=lambda c: risers[c])

    us_10y = markets.get("US", {}).get("tenors", {}).get("10Y")
    peers = [m["tenors"]["10Y"] for c, m in markets.items() if c != "US" and "10Y" in m["tenors"]]
    peer_median = round(float(np.median(peers)), 2) if peers else None

    market_as_of = [m["as_of"] for m in markets.values() if m.get("as_of")]
    return {
        "as_of": max(market_as_of) if market_as_of else None,
        "source": "FRED + national sources (US, DE, UK, JP)",
        "failed_markets": failed,
        "markets": markets,
        "slope_ranking": ranking,
        "summary": {
            "steepest": ranking[0]["market"] if ranking else None,
            "flattest": ranking[-1]["market"] if ranking else None,
            "inverted_count": sum(1 for r in ranking if r["slope_bps"] < 0),
            "n_markets": len(markets),
            "top_1m_riser_10y": riser,
            "us_10y": us_10y,
            "peer_median_10y": peer_median,
            "us_vs_median_bps": round((us_10y - peer_median) * 100, 1)
            if us_10y is not None and peer_median is not None else None,
        },
    }


@router.get("/snapshot")
async def global_rates_snapshot(
    window: int = Query(10, ge=2, le=63, description="Regime classification window, days"),
):
    now = time.time()
    hit = _cache.get(window)
    if hit and now - hit[1] < TTL_SNAPSHOT:
        return hit[0]
    snap = await _build_snapshot(window)
    # Only cache fully successful builds so a transient source failure retries
    if not snap["failed_markets"]:
        _cache[window] = (snap, now)
    return snap
