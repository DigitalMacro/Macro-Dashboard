"""
Shared PLSR model helpers — backend/services/model_service.py
Extracted from main.py so routers (portfolio) can reuse them.
Behavior identical to the original main.py helpers.
"""

import os

import pandas as pd

from data.factor_fetcher import (
    build_factor_dataframe,
    longest_business_day_gap, GAP_THRESHOLD_BUSINESS_DAYS,
)
from data.asset_fetcher import fetch_asset_returns
from models.plsr import fit_plsr, REGRESSION_WINDOW
from cache.simple_cache import cached_fetch

DATA_START = os.environ.get("DATA_START", "1990-01-01")

# TTLs (seconds)
TTL_FACTORS = 4 * 3600   # until ~6pm EST — use 4h as a safe approximation
TTL_PLSR    = 3600       # 1 hour

PREFERRED_FACTOR_COLS = [
    "economic_growth", "metals", "energy", "fwd_growth_expectations",
    "inflation", "ig_credit_spread", "10y_yield", "real_rates",
    "cb_rate_expectations", "dm_fx", "rate_vol", "risk_aversion",
]

# Every fit_plsr() call in this codebase uses REGRESSION_WINDOW (250 trading
# days) — checked directly, including compute_rolling_risk, whose roll_window
# parameter is a *post-fit* rolling-std window applied to the fit's output,
# not the PLSR fit's own window. So one calendar-day lookback covers every
# current-window caller; there's no smaller-window fit anywhere to tie a
# shorter lookback to. 250 trading days * 7/5 ≈ 350 calendar days, +20 day
# buffer for holidays.
CURRENT_WINDOW_CALENDAR_DAYS = REGRESSION_WINDOW * 7 // 5 + 20


def exclude_currently_gapped(fm, cols, lookback_calendar_days=CURRENT_WINDOW_CALENDAR_DAYS,
                              gap_threshold_days=GAP_THRESHOLD_BUSINESS_DAYS):
    """
    Split `cols` into (kept, gapped): a factor is excluded from a
    current-window fit if it has a run of `gap_threshold_days`+ consecutive
    missing business days within the trailing `lookback_calendar_days` of
    fm's own last date. A gap further back than that doesn't affect a fit
    that only looks at the trailing window, so it's left alone — self-heals
    once the gap ages out. See TODO.md item 5 for the ^MOVE case this was
    built for, including the historical-stress-scenario consequence.
    """
    if not cols:
        return cols, []
    window_end = fm.index.max()
    window_start = window_end - pd.Timedelta(days=lookback_calendar_days)
    kept, gapped = [], []
    for c in cols:
        gap = longest_business_day_gap(fm[c], window_start, window_end)
        (gapped if gap >= gap_threshold_days else kept).append(c)
    return kept, gapped


def get_factor_matrix(start: str = DATA_START):
    key = f"factors_normalised_{start}"
    return cached_fetch(key, TTL_FACTORS, lambda: build_factor_dataframe(start=start))


def get_asset_returns(ticker: str, start: str = DATA_START):
    key = f"asset_{ticker}_{start}"
    return cached_fetch(key, TTL_PLSR, lambda: fetch_asset_returns(ticker, start=start))


def select_factor_cols(fm):
    """Return the subset of preferred columns that are actually in fm."""
    return [c for c in PREFERRED_FACTOR_COLS if c in fm.columns]


def get_plsr(ticker: str) -> dict:
    """Cached PLSR fit for a ticker."""
    key = f"plsr_{ticker.upper()}"
    def _fit():
        fm = get_factor_matrix(DATA_START)
        cols = select_factor_cols(fm)
        cols, _gapped = exclude_currently_gapped(fm, cols)
        fm = fm[cols].dropna()
        ar = get_asset_returns(ticker.upper(), DATA_START)
        return fit_plsr(fm, ar, expected_factors=PREFERRED_FACTOR_COLS)
    return cached_fetch(key, TTL_PLSR, _fit)
