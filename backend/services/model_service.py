"""
Shared PLSR model helpers — backend/services/model_service.py
Extracted from main.py so routers (portfolio) can reuse them.
Behavior identical to the original main.py helpers.
"""

import os

from data.factor_fetcher import build_factor_dataframe, get_factor_levels
from data.asset_fetcher import fetch_asset_returns
from models.plsr import fit_plsr
from cache.simple_cache import cached_fetch

DATA_START = os.environ.get("DATA_START", "1990-01-01")

# TTLs (seconds)
TTL_FACTORS = 4 * 3600   # until ~6pm EST — use 4h as a safe approximation
TTL_PLSR    = 3600       # 1 hour

PREFERRED_FACTOR_COLS = [
    "economic_growth", "metals", "energy", "fwd_growth_expectations",
    "inflation", "ig_credit_spread", "10y_yield", "real_rates",
    "cb_rate_expectations", "dm_fx", "cb_qt_expectations", "risk_aversion",
]


def get_factor_matrix(start: str = DATA_START):
    key = f"factors_normalised_{start}"
    return cached_fetch(key, TTL_FACTORS, lambda: build_factor_dataframe(start=start))


def get_factor_levels_cached(start: str):
    key = f"factors_levels_{start}"
    return cached_fetch(key, TTL_FACTORS, lambda: get_factor_levels(start=start))


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
        fm = fm[cols].dropna()
        ar = get_asset_returns(ticker.upper(), DATA_START)
        return fit_plsr(fm, ar, expected_factors=PREFERRED_FACTOR_COLS)
    return cached_fetch(key, TTL_PLSR, _fit)
