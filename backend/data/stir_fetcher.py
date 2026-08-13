"""
STIR data fetcher — EFFR/SOFR from FRED, futures strip from yfinance.
Falls back to a FRED-derived rate curve if yfinance futures are unavailable.
"""
from __future__ import annotations

import logging
import os
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ── CME symbol helpers ────────────────────────────────────────────────────────

_CME_MONTH_CODES = {
    1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
    7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
}


def _cme_symbol(root: str, expiry: date) -> str:
    return f"{root}{_CME_MONTH_CODES[expiry.month]}{expiry.year % 10}"


@dataclass
class Contract:
    symbol: str
    root: str
    expiry: date
    settle: float


def to_strip(contracts: list[Contract]) -> pd.DataFrame:
    """Convert a list of Contract into the canonical strip DataFrame."""
    if not contracts:
        return pd.DataFrame(columns=["symbol", "root", "expiry", "settle"])
    return pd.DataFrame([c.__dict__ for c in contracts])


# ── FOMC calendar (hard-coded; refresh annually from federalreserve.gov) ─────

# These are FOMC meeting end-dates (the day the statement is released).
FOMC_DATES: list[date] = [
    # 2026
    date(2026, 1, 28),
    date(2026, 3, 18),
    date(2026, 4, 29),
    date(2026, 6, 17),
    date(2026, 7, 29),
    date(2026, 9, 16),
    date(2026, 10, 28),
    date(2026, 12, 9),
    # 2027
    date(2027, 1, 27),
    date(2027, 3, 17),
    date(2027, 4, 28),
    date(2027, 6, 16),
    date(2027, 7, 28),
    date(2027, 9, 15),
    date(2027, 10, 27),
    date(2027, 12, 8),
]


def get_fomc_dates(from_date: Optional[date] = None) -> list[date]:
    """Return upcoming FOMC meeting end-dates on or after from_date."""
    today = from_date or date.today()
    return [d for d in FOMC_DATES if d >= today]


# ── Reference rates (FRED) ────────────────────────────────────────────────────

def fetch_reference_rates() -> dict:
    """
    Fetch latest EFFR and SOFR from FRED.
    Returns {"effr": float, "sofr": float, "as_of": str, "source": str}.
    """
    try:
        from fredapi import Fred
        fred = Fred(api_key=os.environ.get("FRED_API_KEY", ""))

        start = "2025-01-01"
        effr_s = fred.get_series("DFF",  observation_start=start)
        sofr_s = fred.get_series("SOFR", observation_start=start)

        effr   = float(effr_s.dropna().iloc[-1])
        sofr   = float(sofr_s.dropna().iloc[-1])
        as_of  = effr_s.dropna().index[-1].date().isoformat()

        return {"effr": effr, "sofr": sofr, "as_of": as_of, "source": "FRED"}

    except Exception as exc:
        logger.warning("FRED reference-rate fetch failed (%s) — using fallback", exc)
        return {
            "effr":   4.33,
            "sofr":   4.35,
            "as_of":  date.today().isoformat(),
            "source": "fallback",
        }


# ── ZQ (30-day Fed Funds) futures ─────────────────────────────────────────────

def _zq_yfinance(today: date, months: int = 14) -> list[Contract]:
    """Try to fetch ZQ contracts from Yahoo Finance (ZQF26.CBT format)."""
    import yfinance as yf

    contracts: list[Contract] = []
    for i in range(months):
        mo   = today.month + i
        y    = today.year + (mo - 1) // 12
        m    = ((mo - 1) % 12) + 1
        exp  = date(y, m, monthrange(y, m)[1])
        sym  = _cme_symbol("ZQ", exp)
        tick = f"{sym}.CBT"
        try:
            hist = yf.Ticker(tick).history(period="5d")
            if hist.empty:
                continue
            settle = float(hist["Close"].iloc[-1])
            if not (90 < settle < 100):
                continue
            contracts.append(Contract(sym, "ZQ", exp, settle))
        except Exception:
            continue

    return contracts


def _zq_fred_derived(today: date, effr: float, months: int = 14) -> list[Contract]:
    """
    Build a synthetic ZQ strip from FRED's forward-rate proxies.
    Uses THREEFF1 (1-yr) and DGS1 (1-yr CMT) as horizon anchors.
    """
    try:
        from fredapi import Fred
        fred = Fred(api_key=os.environ.get("FRED_API_KEY", ""))

        start = "2025-01-01"
        anchors: dict[int, float] = {}

        # 1-month EFFR expectation (FRED)
        for series, horizon_m in [("THREEFF1", 12), ("DGS1", 12), ("DGS2", 24)]:
            try:
                s = fred.get_series(series, observation_start=start)
                if not s.empty:
                    anchors[horizon_m] = float(s.dropna().iloc[-1])
                    break
            except Exception:
                pass

        if not anchors:
            anchors = {12: effr}

    except Exception:
        anchors = {12: effr}

    contracts: list[Contract] = []
    for i in range(months):
        mo  = today.month + i
        y   = today.year + (mo - 1) // 12
        m   = ((mo - 1) % 12) + 1
        exp = date(y, m, monthrange(y, m)[1])
        sym = _cme_symbol("ZQ", exp)

        # Simple linear interpolation between current EFFR and 12m anchor
        horizon   = i + 1
        rate      = _interpolate_rate(effr, anchors, horizon)
        contracts.append(Contract(sym, "ZQ", exp, 100.0 - rate))

    return contracts


# ── SR3 (3-month SOFR) futures ────────────────────────────────────────────────

def _sr3_yfinance(today: date, quarters: int = 8) -> list[Contract]:
    """Try to fetch SR3 contracts from Yahoo Finance (SR3H26.CME format)."""
    import yfinance as yf

    # Build the next `quarters` quarterly expiry months (Mar/Jun/Sep/Dec)
    future_quarters: list[tuple[int, int]] = []
    y, m = today.year, today.month
    while len(future_quarters) < quarters:
        m += 1
        if m > 12:
            m = 1
            y += 1
        if m in (3, 6, 9, 12):
            future_quarters.append((y, m))

    contracts: list[Contract] = []
    for (yr, mo) in future_quarters:
        exp  = date(yr, mo, monthrange(yr, mo)[1])
        sym  = _cme_symbol("SR3", exp)
        tick = f"{sym}.CME"
        try:
            hist = yf.Ticker(tick).history(period="5d")
            if hist.empty:
                continue
            settle = float(hist["Close"].iloc[-1])
            if not (90 < settle < 100):
                continue
            contracts.append(Contract(sym, "SR3", exp, settle))
        except Exception:
            continue

    return contracts


def _sr3_sofr_derived(today: date, sofr: float, quarters: int = 8) -> list[Contract]:
    """
    Build a synthetic SR3 strip from FRED SOFR term/average series.
    """
    try:
        from fredapi import Fred
        fred = Fred(api_key=os.environ.get("FRED_API_KEY", ""))

        start   = "2025-01-01"
        anchors: dict[int, float] = {3: sofr}

        for series, horizon_m in [
            ("SOFR90DAYAVG", 3),
            ("SOFR180DAYAVG", 6),
        ]:
            try:
                s = fred.get_series(series, observation_start=start)
                if not s.empty:
                    anchors[horizon_m] = float(s.dropna().iloc[-1])
            except Exception:
                pass

    except Exception:
        anchors = {3: sofr}

    future_quarters: list[tuple[int, int]] = []
    y, m = today.year, today.month
    while len(future_quarters) < quarters:
        m += 1
        if m > 12:
            m = 1
            y += 1
        if m in (3, 6, 9, 12):
            future_quarters.append((y, m))

    contracts: list[Contract] = []
    for i, (yr, mo) in enumerate(future_quarters):
        exp     = date(yr, mo, monthrange(yr, mo)[1])
        sym     = _cme_symbol("SR3", exp)
        horizon = (i + 1) * 3
        rate    = _interpolate_rate(sofr, anchors, horizon)
        contracts.append(Contract(sym, "SR3", exp, 100.0 - rate))

    return contracts


# ── Helpers ───────────────────────────────────────────────────────────────────

def _interpolate_rate(current: float, anchors: dict[int, float], horizon: int) -> float:
    """Piecewise-linear interpolation between anchor (horizon_months, rate) points."""
    if not anchors:
        return current

    pts = sorted(anchors.items())  # [(months, rate), ...]

    if horizon <= pts[0][0]:
        # Blend current→first anchor proportionally
        frac = horizon / pts[0][0]
        return current + frac * (pts[0][1] - current)

    if horizon >= pts[-1][0]:
        return pts[-1][1]

    for i, (m1, r1) in enumerate(pts[:-1]):
        m2, r2 = pts[i + 1]
        if m1 <= horizon <= m2:
            frac = (horizon - m1) / (m2 - m1)
            return r1 + frac * (r2 - r1)

    return current


# ── Public interface ──────────────────────────────────────────────────────────

def fetch_futures_strip(
    today: date,
    effr: float,
    sofr: float,
) -> tuple[pd.DataFrame, str]:
    """
    Fetch (or synthesise) the SR3 + ZQ futures strip.

    Strategy per product:
      1. Try yfinance with CME standard symbols.
      2. If < 3 contracts return, fall back to FRED-derived curve.

    Returns:
      strip_df  — canonical DataFrame (symbol, root, expiry, settle)
      source_note — human-readable description of data provenance
    """
    # ZQ strip
    zq = _zq_yfinance(today, months=14)
    zq_src = "yfinance"
    if len(zq) < 3:
        logger.info("ZQ yfinance: only %d contracts; falling back to FRED-derived", len(zq))
        zq     = _zq_fred_derived(today, effr, months=14)
        zq_src = "FRED-derived"

    # SR3 strip
    sr3 = _sr3_yfinance(today, quarters=8)
    sr3_src = "yfinance"
    if len(sr3) < 2:
        logger.info("SR3 yfinance: only %d contracts; falling back to SOFR-derived", len(sr3))
        sr3     = _sr3_sofr_derived(today, sofr, quarters=8)
        sr3_src = "SOFR-derived"

    strip = (
        to_strip(zq + sr3)
        .sort_values(["root", "expiry"])
        .reset_index(drop=True)
    )
    source_note = f"ZQ: {zq_src} · SR3: {sr3_src}"
    return strip, source_note
