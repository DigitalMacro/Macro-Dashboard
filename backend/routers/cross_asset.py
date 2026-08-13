"""
Cross-Asset Regimes API — backend/routers/cross_asset.py

Classifies each trading day into one of 8 directional regimes from the sign of
vol-scaled SPX / UST 10Y / DXY signals, with BTC overlaid as a fourth signal
(own direction, per-regime performance, macro correlations, PCA linkage).

Sources (verified live 2026-07-19): yfinance ^GSPC, DX-Y.NYB, BTC-USD all
return data — SPY/UUP fallbacks are wired but inactive. UST 10Y via shared
FRED DGS10.
"""

import time
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

from services.fred_service import fetch_fred_daily

router = APIRouter(prefix="/api/cross-asset", tags=["cross-asset"])


def _sanitise(obj):
    """Recursively replace NaN/Inf floats with None for JSON serialisation."""
    if isinstance(obj, float):
        return None if (np.isnan(obj) or np.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitise(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitise(v) for v in obj]
    return obj

TTL_SNAPSHOT = 4 * 3600
WINDOW_2Y = 504  # trading days

REGIME_DEFS = {
    "R1": {"spx": "up",   "rates": "up",   "dxy": "up"},
    "R2": {"spx": "up",   "rates": "up",   "dxy": "down"},
    "R3": {"spx": "up",   "rates": "down", "dxy": "up"},
    "R4": {"spx": "up",   "rates": "down", "dxy": "down"},
    "R5": {"spx": "down", "rates": "up",   "dxy": "up"},
    "R6": {"spx": "down", "rates": "up",   "dxy": "down"},
    "R7": {"spx": "down", "rates": "down", "dxy": "up"},
    "R8": {"spx": "down", "rates": "down", "dxy": "down"},
}

REGIME_COLORS = {
    "R1": "#34d399", "R2": "#10b981",   # SPX up + rates up: greens
    "R3": "#38bdf8", "R4": "#0ea5e9",   # SPX up + rates down: blues
    "R5": "#f87171", "R6": "#fb923c",   # SPX down + rates up: red/orange
    "R7": "#a78bfa", "R8": "#c084fc",   # SPX down + rates down: purples
}

# (spx_up, rates_up, dxy_up) → regime key
_SIGN_TO_REGIME = {
    (True, True, True): "R1", (True, True, False): "R2",
    (True, False, True): "R3", (True, False, False): "R4",
    (False, True, True): "R5", (False, True, False): "R6",
    (False, False, True): "R7", (False, False, False): "R8",
}


def _regime_label(key: str) -> str:
    d = REGIME_DEFS[key]
    return (f"SPX {'UP' if d['spx'] == 'up' else 'DN'} · "
            f"RATES {'UP' if d['rates'] == 'up' else 'DN'} · "
            f"DXY {'UP' if d['dxy'] == 'up' else 'DN'}")


def _yf_close(ticker: str, period: str = "3y") -> pd.Series:
    raw = yf.download(ticker, period=period, progress=False, auto_adjust=True)
    if raw.empty:
        raise RuntimeError(f"yfinance returned no data for {ticker}")
    close = raw["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.squeeze("columns")
    if close.index.tz is not None:
        close.index = close.index.tz_localize(None)
    return close.dropna()


def _fetch_with_fallback(primary: str, fallback: str) -> tuple:
    """(series, source_label) — falls back with honest labeling."""
    try:
        return _yf_close(primary), primary
    except Exception:
        return _yf_close(fallback), f"{fallback} proxy"


def _pc1_share(window: pd.DataFrame) -> Optional[float]:
    """PC1 variance share of z-scored daily moves in the window."""
    clean = window.dropna()
    if len(clean) < 20:
        return None
    std = clean.std().replace(0, np.nan)
    if std.isna().any():
        return None
    z = (clean - clean.mean()) / std
    corr = np.corrcoef(z.values.T)
    eig = np.linalg.eigvalsh(corr)
    return float(eig.max() / eig.sum())


def _avg_run_length(mask: pd.Series) -> float:
    """Average consecutive-True run length in a boolean series."""
    runs, run = [], 0
    for v in mask:
        if v:
            run += 1
        elif run:
            runs.append(run)
            run = 0
    if run:
        runs.append(run)
    return round(float(np.mean(runs)), 1) if runs else 0.0


# Manual snapshot cache keyed by (lookback, vol_window)
_cache: dict = {}


def _fetch_yf_data() -> tuple:
    """All sync yfinance fetches, bundled to run off the event loop."""
    spx, spx_src = _fetch_with_fallback("^GSPC", "SPY")
    dxy, dxy_src = _fetch_with_fallback("DX-Y.NYB", "UUP")
    btc = _yf_close("BTC-USD")
    return spx, spx_src, dxy, dxy_src, btc


async def _build_snapshot(lookback: int, vol_window: int) -> dict:
    # ── Fetch (SPX calendar is the master index) ──────────────────────────────
    # yfinance is sync and can stall for minutes when rate-limited — run it in
    # a worker thread so the event loop (and /api/health) stays responsive.
    import asyncio
    spx, spx_src, dxy, dxy_src, btc = await asyncio.to_thread(_fetch_yf_data)
    dgs10 = await fetch_fred_daily("DGS10", 1200)

    idx = spx.index
    # BTC reindexed to the NYSE calendar BEFORE returns — Monday spans the weekend
    btc_al = btc.reindex(idx)
    dxy_al = dxy.reindex(idx).ffill(limit=3)
    y10_al = dgs10.reindex(idx).ffill(limit=3)

    # ── Daily moves ───────────────────────────────────────────────────────────
    moves = pd.DataFrame({
        "spx": spx.pct_change() * 100,
        "rates": y10_al.diff() * 100,   # bp — rates UP = yields rising
        "dxy": dxy_al.pct_change() * 100,
        "btc": btc_al.pct_change() * 100,
    })

    # ── Vol-scaled signals ────────────────────────────────────────────────────
    signals = pd.DataFrame({
        c: moves[c].rolling(lookback).sum()
           / moves[c].rolling(vol_window).std().replace(0, np.nan)
        for c in moves.columns
    })

    core = signals[["spx", "rates", "dxy"]].dropna()
    if core.empty:
        raise HTTPException(status_code=502, detail={
            "error": "No usable signal data", "code": "NO_DATA",
            "detail": "Signal computation produced no valid rows",
        })

    regime = pd.Series(
        [_SIGN_TO_REGIME[(r["spx"] > 0, r["rates"] > 0, r["dxy"] > 0)]
         for _, r in core.iterrows()],
        index=core.index,
    )

    win = regime.tail(WINDOW_2Y)
    sig_win = signals.reindex(win.index)

    # ── Current state ─────────────────────────────────────────────────────────
    cur_regime = str(win.iloc[-1])
    changed = win[win != cur_regime]
    days_in = int((win.index > changed.index[-1]).sum()) if not changed.empty else len(win)

    cur_sig = sig_win.iloc[-1]
    btc_sig = float(cur_sig["btc"]) if not np.isnan(cur_sig["btc"]) else 0.0
    btc_state = "up" if btc_sig > 0 else "down"
    spx_up = float(cur_sig["spx"]) > 0

    def _pct_chg(s: pd.Series, n: int = 21) -> Optional[float]:
        s = s.dropna()
        if len(s) <= n:
            return None
        return round((float(s.iloc[-1]) / float(s.iloc[-1 - n]) - 1) * 100, 1)

    y10_clean = y10_al.dropna()
    current = {
        "regime": cur_regime,
        "regime_label": _regime_label(cur_regime),
        "days_in_regime": days_in,
        "signals": {
            c: round(float(cur_sig[c]), 2) if not np.isnan(cur_sig[c]) else 0.0
            for c in ["spx", "rates", "dxy", "btc"]
        },
        "btc_state": btc_state,
        "btc_aligned_with_spx": (btc_sig > 0) == spx_up,
        "levels": {
            "spx": round(float(spx.iloc[-1]), 0),
            "spx_1m_pct": _pct_chg(spx),
            "ust10y": round(float(y10_clean.iloc[-1]), 2),
            "ust10y_1m_bp": round((float(y10_clean.iloc[-1]) - float(y10_clean.iloc[-22])) * 100, 0)
            if len(y10_clean) > 22 else None,
            "dxy": round(float(dxy_al.dropna().iloc[-1]), 1),
            "dxy_1m_pct": _pct_chg(dxy_al),
            "btc": round(float(btc_al.dropna().iloc[-1]), 0),
            "btc_1m_pct": _pct_chg(btc_al),
        },
    }

    # ── Signal series for the chart ───────────────────────────────────────────
    signal_series = [
        {
            "date": d.strftime("%Y-%m-%d"),
            **{c: round(float(sig_win.loc[d, c]), 2)
               if not np.isnan(sig_win.loc[d, c]) else None
               for c in ["spx", "rates", "dxy", "btc"]},
            "regime": win.loc[d],
        }
        for d in win.index
    ]

    # ── Rolling correlations (raw daily moves, 20D) ───────────────────────────
    pairs = {
        "spx_rates": ("spx", "rates"), "spx_dxy": ("spx", "dxy"),
        "rates_dxy": ("rates", "dxy"), "btc_spx": ("btc", "spx"),
        "btc_rates": ("btc", "rates"), "btc_dxy": ("btc", "dxy"),
    }
    corr_df = pd.DataFrame({
        name: moves[a].rolling(20).corr(moves[b]) for name, (a, b) in pairs.items()
    })
    corr_df["avg_abs_core"] = (
        corr_df[["spx_rates", "spx_dxy", "rates_dxy"]].abs().mean(axis=1)
    )
    corr_win = corr_df.reindex(win.index)
    corr_series = [
        {
            "date": d.strftime("%Y-%m-%d"),
            **{c: round(float(v), 2) if not np.isnan(v) else None
               for c, v in corr_win.loc[d].items()},
        }
        for d in corr_win.index
    ]
    corr_last = corr_win.dropna().iloc[-1] if not corr_win.dropna().empty else None
    corr_current = (
        {c: round(float(corr_last[c]), 2) for c in pairs} if corr_last is not None else {}
    )

    # ── PCA linkage ───────────────────────────────────────────────────────────
    core_moves = moves[["spx", "rates", "dxy"]]
    linkage_vals = {}
    for i, d in enumerate(win.index):
        loc = moves.index.get_loc(d)
        if loc >= 63:
            share = _pc1_share(core_moves.iloc[loc - 62: loc + 1])
            if share is not None:
                linkage_vals[d] = share
    linkage_series = [
        {"date": d.strftime("%Y-%m-%d"), "pc1_share": round(v, 3)}
        for d, v in linkage_vals.items()
    ]
    cur_share = list(linkage_vals.values())[-1] if linkage_vals else None
    pctile = (
        round(float(np.mean([v <= cur_share for v in linkage_vals.values()])) * 100)
        if cur_share is not None else None
    )
    with_btc = _pc1_share(moves.iloc[-63:])

    # BTC "in the complex" test: compare the 4-asset PC1 share against the
    # midpoint between (a) BTC fully independent — share dilutes to 3s/4 —
    # and (b) BTC fully joined — share ≈ (3s+1)/4.
    btc_in_complex = None
    if cur_share is not None and with_btc is not None:
        threshold = (cur_share * 6 + 1) / 8
        btc_in_complex = with_btc >= threshold

    linkage = {
        "series": linkage_series,
        "current_pc1_share": round(cur_share, 3) if cur_share is not None else None,
        "percentile_2y": pctile,
        "with_btc_pc1_share": round(with_btc, 3) if with_btc is not None else None,
        "btc_in_complex": btc_in_complex,
    }

    # ── Regime stats over the 2Y window ───────────────────────────────────────
    btc_ret_win = moves["btc"].reindex(win.index)
    spx_ret_win = moves["spx"].reindex(win.index)
    total_days = len(win)
    regime_stats = []
    for key in REGIME_DEFS:
        mask = win == key
        n = int(mask.sum())
        btc_in = btc_ret_win[mask].dropna()
        spx_in = spx_ret_win[mask].dropna()
        regime_stats.append({
            "regime": key,
            "label": _regime_label(key),
            "days": n,
            "share": round(n / total_days * 100, 1) if total_days else 0.0,
            "avg_run": _avg_run_length(mask),
            "btc_avg_daily_ret": round(float(btc_in.mean()), 2) if not btc_in.empty else None,
            "btc_hit_rate": round(float((btc_in > 0).mean()), 2) if not btc_in.empty else None,
            "spx_avg_daily_ret": round(float(spx_in.mean()), 2) if not spx_in.empty else None,
        })

    most_freq = max(regime_stats, key=lambda r: r["days"])

    return _sanitise({
        "as_of": idx[-1].strftime("%Y-%m-%d") if len(idx) else None,
        "source": f"yfinance ({spx_src}, {dxy_src}, BTC-USD) + FRED (DGS10)",
        "sources": {"spx": spx_src, "dxy": dxy_src, "btc": "BTC-USD", "rates": "FRED:DGS10"},
        "lookback": lookback,
        "vol_window": vol_window,
        "current": current,
        "signal_series": signal_series,
        "correlations": {"series": corr_series, "current": corr_current},
        "linkage": linkage,
        "regime_stats": regime_stats,
        "most_frequent_2y": {"regime": most_freq["regime"], "share": most_freq["share"]},
        "regimes": {
            k: {"label": _regime_label(k), "color": REGIME_COLORS[k]} for k in REGIME_DEFS
        },
    })


@router.get("/snapshot")
async def cross_asset_snapshot(
    lookback: int = Query(20, ge=5, le=63, description="Signal lookback, sessions"),
    vol_window: int = Query(21, ge=5, le=63, description="Vol scaling window, sessions"),
):
    key = (lookback, vol_window)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[1] < TTL_SNAPSHOT:
        return hit[0]
    snap = await _build_snapshot(lookback, vol_window)
    _cache[key] = (snap, now)
    return snap
