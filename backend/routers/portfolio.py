"""
Portfolio Risk Overlay API — backend/routers/portfolio.py

Mock L/S paper-trading book: manual position entry, daily mark-to-market via
yfinance, factor decomposition through the existing MFERM PLSR model, and
benchmark-relative performance vs SPY.
"""

import time
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from cache.simple_cache import cached_fetch
from data.asset_fetcher import validate_ticker
from db import portfolio_store as store
from services import model_service

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])

TTL_PRICES = 3600  # 1 hour, matches spec

MAX_POSITION_WEIGHT = 25.0   # % of book per position
MAX_GROSS_EXPOSURE  = 200.0  # % gross cap (100 long / 100 short)

BENCHMARK = "SPY"

# Ticker → regime-heatmap asset class, for the regime consistency score.
# Unknown tickers are treated as generic equities (SPX bucket).
HEATMAP_CLASS_MAP = {
    "SPY": "SPX", "QQQ": "SPX", "IWM": "SPX",
    "TLT": "Bonds", "IEF": "Bonds",
    "GLD": "Gold",
    "DJP": "Cmdty", "USO": "Cmdty",
    "BTC-USD": "BTC", "ETH-USD": "BTC",
    "TIP": "TIPS",
    "HYG": "HY", "LQD": "HY",
}


# ── Request models ────────────────────────────────────────────────────────────

class PositionCreate(BaseModel):
    ticker: str
    side: str          # "long" | "short"
    weight: float      # percent of book
    entry_date: str    # ISO date
    thesis: Optional[str] = None


class PositionClose(BaseModel):
    exit_date: str


# ── Price helpers ─────────────────────────────────────────────────────────────

def _err(status: int, code: str, msg: str):
    return HTTPException(status_code=status, detail={
        "error": msg, "code": code, "detail": msg
    })


def resolve_price_on(ticker: str, iso_date: str) -> tuple:
    """
    Close price for `iso_date`, rolling forward to the next trading day if the
    date is a weekend/holiday. Returns (effective_iso_date, price).
    Raises HTTPException 422 if no price can be resolved.
    """
    try:
        target = pd.Timestamp(iso_date)
    except (ValueError, TypeError):
        raise _err(422, "INVALID_DATE", f"Invalid date: {iso_date}")

    try:
        hist = yf.Ticker(ticker).history(
            start=target.strftime("%Y-%m-%d"),
            end=(target + timedelta(days=8)).strftime("%Y-%m-%d"),
            auto_adjust=True,
        )
    except Exception as e:
        raise _err(422, "PRICE_FETCH_FAILED", f"Price fetch failed for {ticker}: {e}")

    if hist.empty or "Close" not in hist:
        raise _err(422, "PRICE_UNRESOLVED",
                   f"No trading data for {ticker} on/after {iso_date}")

    first = hist.iloc[0]
    eff_date = hist.index[0]
    if getattr(eff_date, "tzinfo", None) is not None:
        eff_date = eff_date.tz_localize(None)
    return eff_date.strftime("%Y-%m-%d"), float(first["Close"])


def _fetch_close_frame(tickers: tuple, start: str) -> pd.DataFrame:
    """Batch daily closes for all tickers since `start` — one yf.download call."""
    def _dl():
        raw = yf.download(
            list(tickers), start=start, progress=False,
            auto_adjust=True, group_by="column",
        )
        if raw.empty:
            return pd.DataFrame()
        close = raw["Close"]
        if isinstance(close, pd.Series):  # single ticker
            close = close.to_frame(tickers[0])
        if close.index.tz is not None:
            close.index = close.index.tz_localize(None)
        return close.sort_index()

    key = f"portfolio_closes_{'_'.join(sorted(tickers))}_{start}"
    return cached_fetch(key, TTL_PRICES, _dl)


# ── Regime context (reuses the regime router's classification) ───────────────

_regime_cache: dict = {"data": None, "ts": 0.0}


async def _get_regime_snapshot_cached() -> Optional[dict]:
    """Current regime snapshot, cached 1h. None if the fetch fails."""
    now = time.time()
    if _regime_cache["data"] is not None and now - _regime_cache["ts"] < 3600:
        return _regime_cache["data"]
    try:
        from routers.regime import regime_snapshot
        snap = await regime_snapshot(
            method="roc", roc_window=3, zscore_window=36, market_weight=0.4
        )
        _regime_cache["data"] = snap
        _regime_cache["ts"] = now
        return snap
    except Exception:
        return None


def _regime_consistency(positions: list, regime_snap: Optional[dict]) -> dict:
    """
    Score ∈ [-1, 1]: are the book's net tilts aligned with the assets that
    historically outperform in the current regime?  Each position maps to a
    regime-heatmap asset class (generic equities → SPX); class scores are the
    heatmap's avg monthly returns for the current regime scaled to [-1, 1].
    """
    if not regime_snap:
        return {"current_regime": None, "regime_consistency_score": None}

    regime = regime_snap.get("current_regime")
    heatmap = regime_snap.get("asset_heatmap", {})

    class_returns = {
        cls: vals.get(regime)
        for cls, vals in heatmap.items()
        if isinstance(vals, dict) and vals.get(regime) is not None
    }
    open_pos = [p for p in positions if p["status"] == "open"]
    if not class_returns or not open_pos:
        return {"current_regime": regime, "regime_consistency_score": None}

    max_abs = max(abs(v) for v in class_returns.values())
    if max_abs == 0:
        return {"current_regime": regime, "regime_consistency_score": 0.0}
    class_scores = {cls: v / max_abs for cls, v in class_returns.items()}

    num, denom = 0.0, 0.0
    for p in open_pos:
        cls = HEATMAP_CLASS_MAP.get(p["ticker"], "SPX")
        score = class_scores.get(cls)
        if score is None:
            continue
        w = p["weight"] / 100.0
        signed = w if p["side"] == "long" else -w
        num += signed * score
        denom += abs(w)

    if denom == 0:
        return {"current_regime": regime, "regime_consistency_score": None}
    return {
        "current_regime": regime,
        "regime_consistency_score": round(max(-1.0, min(1.0, num / denom)), 3),
    }


# ── P&L helpers ───────────────────────────────────────────────────────────────

def _position_pnl_pct(side: str, entry: float, mark: float) -> float:
    """Long: price ratio − 1. Short: inverse ratio − 1 (price fall = gain)."""
    if side == "long":
        return (mark / entry - 1.0) * 100.0
    return (entry / mark - 1.0) * 100.0


def _mark_positions(positions: list, closes: pd.DataFrame) -> list:
    """Attach current_price / pnl_pct / pnl_contribution_bps to each position."""
    out = []
    for p in positions:
        q = dict(p)
        entry = p["entry_price"]
        if p["status"] == "closed":
            mark = p["exit_price"]
            q["current_price"] = round(float(mark), 2) if mark is not None else None
        else:
            mark = None
            if p["ticker"] in closes.columns:
                series = closes[p["ticker"]].dropna()
                if not series.empty:
                    mark = float(series.iloc[-1])
            q["current_price"] = round(mark, 2) if mark is not None else None

        if entry and mark:
            pnl = _position_pnl_pct(p["side"], float(entry), float(mark))
            q["pnl_pct"] = round(pnl, 2)
            q["pnl_contribution_bps"] = round(pnl * p["weight"], 1)
        else:
            q["pnl_pct"] = None
            q["pnl_contribution_bps"] = None
        out.append(q)
    return out


def _pnl_series(positions: list, closes: pd.DataFrame, inception: str) -> list:
    """
    Daily cumulative book P&L (bps) vs SPY (%) rebased at inception.
    Closed positions freeze at their realized contribution after exit.
    """
    if closes.empty:
        return []
    idx = closes.index[closes.index >= pd.Timestamp(inception)]
    if len(idx) == 0:
        return []

    total = pd.Series(0.0, index=idx)
    for p in positions:
        if not p["entry_price"] or p["ticker"] not in closes.columns:
            continue
        entry_ts = pd.Timestamp(p["entry_date"])
        px = closes[p["ticker"]].reindex(idx).ffill()
        active = idx >= entry_ts
        if p["status"] == "closed":
            exit_ts = pd.Timestamp(p["exit_date"])
            live = active & (idx <= exit_ts)
        else:
            live = active

        entry = float(p["entry_price"])
        if p["side"] == "long":
            pnl_pct = (px / entry - 1.0) * 100.0
        else:
            pnl_pct = (entry / px - 1.0) * 100.0
        contrib = pnl_pct * p["weight"]  # bps of book

        c = pd.Series(np.nan, index=idx)
        c[live] = contrib[live]
        if p["status"] == "closed" and p["exit_price"]:
            realized = _position_pnl_pct(p["side"], entry, float(p["exit_price"])) * p["weight"]
            c[idx > pd.Timestamp(p["exit_date"])] = realized
        c = c.ffill().fillna(0.0)
        total = total + c

    spy = closes[BENCHMARK].reindex(idx).ffill() if BENCHMARK in closes.columns else None
    series = []
    for d in idx:
        point = {
            "date": d.strftime("%Y-%m-%d"),
            "portfolio_cum_bps": round(float(total.loc[d]), 1),
        }
        if spy is not None and not np.isnan(spy.loc[d]) and not np.isnan(spy.iloc[0]):
            point["spy_cum_pct"] = round((float(spy.loc[d]) / float(spy.iloc[0]) - 1.0) * 100.0, 2)
        else:
            point["spy_cum_pct"] = None
        series.append(point)
    return series


# ── Factor aggregation ────────────────────────────────────────────────────────

def _factor_block(positions: list) -> tuple:
    """
    (factor_exposures, factor_pnl_attribution, coverage_pct, total_attr_bps)
    Exposures: Σ signed_weight × beta over open positions.
    Attribution: Σ over days Σ positions signed_weight × beta × factor_return, bps.
    """
    open_pos = [p for p in positions if p["status"] == "open"]
    if not open_pos:
        return {}, {}, None, 0.0, []

    fm = model_service.get_factor_matrix()
    cols = model_service.select_factor_cols(fm)
    cols, _gapped = model_service.exclude_currently_gapped(fm, cols)
    fm = fm[cols].dropna()
    factors_missing = [f for f in model_service.PREFERRED_FACTOR_COLS if f not in cols]

    exposures = {c: 0.0 for c in cols}
    attribution = {c: 0.0 for c in cols}
    modeled_gross = 0.0
    total_gross = sum(p["weight"] for p in open_pos)

    for p in open_pos:
        try:
            fit = model_service.get_plsr(p["ticker"])
        except Exception:
            continue  # insufficient data — excluded, reflected in coverage
        betas = fit["exposures"]
        w = p["weight"] / 100.0
        signed = w if p["side"] == "long" else -w
        modeled_gross += p["weight"]

        # Daily factor returns over the position's live window
        window = fm[fm.index >= pd.Timestamp(p["entry_date"])]
        if p["status"] == "closed":
            window = window[window.index <= pd.Timestamp(p["exit_date"])]

        for c in cols:
            b = float(betas.get(c, 0.0))
            exposures[c] += signed * b
            if not window.empty:
                # position daily % return from factor c → book % → bps
                attribution[c] += signed * b * float(window[c].sum()) * 100.0

    coverage = round(modeled_gross / total_gross * 100.0, 1) if total_gross > 0 else None
    exposures = {c: round(v, 4) for c, v in exposures.items()}
    attribution = {c: round(v, 1) for c, v in attribution.items()}
    total_attr = float(sum(attribution.values()))
    return exposures, attribution, coverage, total_attr, factors_missing


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/positions")
def create_position(body: PositionCreate):
    side = body.side.lower()
    if side not in ("long", "short"):
        raise _err(422, "INVALID_SIDE", "side must be 'long' or 'short'")

    if not (0 < body.weight <= MAX_POSITION_WEIGHT):
        raise _err(422, "WEIGHT_CAP",
                   f"weight must be > 0 and ≤ {MAX_POSITION_WEIGHT}% of book")

    ticker = body.ticker.upper().strip()
    v = validate_ticker(ticker)
    if not v.get("valid"):
        raise _err(422, "INVALID_TICKER", v.get("error", f"Unknown ticker {ticker}"))

    try:
        entry_ts = pd.Timestamp(body.entry_date)
    except (ValueError, TypeError):
        raise _err(422, "INVALID_DATE", f"Invalid entry_date: {body.entry_date}")
    if entry_ts.date() > date.today():
        raise _err(422, "FUTURE_DATE", "entry_date cannot be in the future")

    gross = sum(p["weight"] for p in store.get_open_positions())
    if gross + body.weight > MAX_GROSS_EXPOSURE:
        raise _err(422, "GROSS_CAP",
                   f"Gross exposure cap {MAX_GROSS_EXPOSURE}% exceeded "
                   f"({gross:.1f}% open + {body.weight:.1f}% new)")

    eff_date, price = resolve_price_on(ticker, body.entry_date)
    pos = store.add_position(ticker, side, body.weight, eff_date, price, body.thesis)
    return pos


@router.delete("/positions/{position_id}")
def remove_position(position_id: int):
    if not store.delete_position(position_id):
        raise _err(404, "NOT_FOUND", f"Position {position_id} not found")
    return {"deleted": position_id}


@router.post("/positions/{position_id}/close")
def close_position(position_id: int, body: PositionClose):
    pos = store.get_position(position_id)
    if pos is None:
        raise _err(404, "NOT_FOUND", f"Position {position_id} not found")
    if pos["status"] == "closed":
        raise _err(422, "ALREADY_CLOSED", f"Position {position_id} is already closed")

    try:
        exit_ts = pd.Timestamp(body.exit_date)
    except (ValueError, TypeError):
        raise _err(422, "INVALID_DATE", f"Invalid exit_date: {body.exit_date}")
    if exit_ts.date() > date.today():
        raise _err(422, "FUTURE_DATE", "exit_date cannot be in the future")
    if exit_ts < pd.Timestamp(pos["entry_date"]):
        raise _err(422, "EXIT_BEFORE_ENTRY", "exit_date is before entry_date")

    eff_date, price = resolve_price_on(pos["ticker"], body.exit_date)
    closed = store.close_position(position_id, eff_date, price)
    if closed is None:
        raise _err(422, "ALREADY_CLOSED", f"Position {position_id} is already closed")
    return closed


@router.get("/snapshot")
async def portfolio_snapshot():
    positions = store.get_all_positions()

    if not positions:
        return {
            "as_of": None,
            "source": None,
            "positions": [],
            "summary": {
                "gross_exposure": 0.0, "net_exposure": 0.0,
                "long_exposure": 0.0, "short_exposure": 0.0,
                "n_open": 0, "n_closed": 0,
                "total_pnl_bps": 0.0, "realized_pnl_bps": 0.0,
                "unrealized_pnl_bps": 0.0,
                "spy_return_since_inception_pct": None,
                "portfolio_return_pct": 0.0,
                "active_return_pct": None,
                "factor_coverage_pct": None,
            },
            "pnl_series": [],
            "factor_exposures": {},
            "factor_pnl_attribution": {},
            "factors_missing": [],
            "regime_context": {"current_regime": None, "regime_consistency_score": None},
        }

    inception = min(p["entry_date"] for p in positions)
    tickers = tuple(sorted({p["ticker"] for p in positions} | {BENCHMARK}))
    closes = _fetch_close_frame(tickers, inception)
    as_of = closes.index[-1].strftime("%Y-%m-%d") if len(closes) else None

    marked = _mark_positions(positions, closes)
    open_marked = [p for p in marked if p["status"] == "open"]
    closed_marked = [p for p in marked if p["status"] == "closed"]

    long_exp = sum(p["weight"] for p in open_marked if p["side"] == "long")
    short_exp = sum(p["weight"] for p in open_marked if p["side"] == "short")
    unrealized = sum(p["pnl_contribution_bps"] or 0.0 for p in open_marked)
    realized = sum(p["pnl_contribution_bps"] or 0.0 for p in closed_marked)
    total_pnl = unrealized + realized

    # SPY since inception
    spy_ret = None
    if BENCHMARK in closes.columns:
        spy = closes[BENCHMARK].dropna()
        spy = spy[spy.index >= pd.Timestamp(inception)]
        if len(spy) >= 2:
            spy_ret = round((float(spy.iloc[-1]) / float(spy.iloc[0]) - 1.0) * 100.0, 2)

    portfolio_ret = round(total_pnl / 100.0, 2)
    active_ret = round(portfolio_ret - spy_ret, 2) if spy_ret is not None else None

    exposures, attribution, coverage, total_attr, factors_missing = _factor_block(marked)
    if attribution:
        attribution["residual"] = round(total_pnl - total_attr, 1)

    regime_snap = await _get_regime_snapshot_cached()

    # Sort open positions by contribution descending (spec: table order)
    open_sorted = sorted(
        open_marked,
        key=lambda p: p["pnl_contribution_bps"] if p["pnl_contribution_bps"] is not None else -1e9,
        reverse=True,
    )

    return {
        "as_of": as_of,
        "source": "yfinance (mark-to-market) + FRED/yfinance (factor model)",
        "positions": open_sorted + closed_marked,
        "summary": {
            "gross_exposure": round(long_exp + short_exp, 1),
            "net_exposure": round(long_exp - short_exp, 1),
            "long_exposure": round(long_exp, 1),
            "short_exposure": round(short_exp, 1),
            "n_open": len(open_marked),
            "n_closed": len(closed_marked),
            "total_pnl_bps": round(total_pnl, 1),
            "realized_pnl_bps": round(realized, 1),
            "unrealized_pnl_bps": round(unrealized, 1),
            "spy_return_since_inception_pct": spy_ret,
            "portfolio_return_pct": portfolio_ret,
            "active_return_pct": active_ret,
            "factor_coverage_pct": coverage,
        },
        "pnl_series": _pnl_series(marked, closes, inception),
        "factor_exposures": exposures,
        "factor_pnl_attribution": attribution,
        "factors_missing": factors_missing,
        "regime_context": _regime_consistency(marked, regime_snap),
    }
