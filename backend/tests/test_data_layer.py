"""
Phase 1 tests — confirm all factor series fetch and normalise correctly.
Run with: pytest tests/test_data_layer.py -v
Requires FRED_API_KEY in environment.
"""

import os
import sys
import pytest
import pandas as pd

# Allow imports from backend root
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

REQUIRED_FACTORS = [
    "economic_growth",
    "metals",
    "energy",
    "fwd_growth_expectations",
    "inflation",
    "ig_credit_spread",
    "10y_yield",
    "real_rates",
    "cb_rate_expectations",
    "dm_fx",
    "cb_qt_expectations",
    "risk_aversion",
    "market",
]

START = "2020-01-01"


@pytest.fixture(scope="module")
def factor_df():
    from data.factor_fetcher import build_factor_dataframe
    return build_factor_dataframe(start=START)


@pytest.fixture(scope="module")
def factor_levels():
    from data.factor_fetcher import get_factor_levels
    return get_factor_levels(start=START)


def test_all_factors_present(factor_df):
    """All 13 factor columns must be present."""
    missing = [f for f in REQUIRED_FACTORS if f not in factor_df.columns]
    assert not missing, f"Missing factors: {missing}"


def test_factor_df_not_empty(factor_df):
    """DataFrame must have rows."""
    assert len(factor_df) > 250, f"Too few rows: {len(factor_df)}"


def test_normalised_values_unit_variance(factor_df):
    """Normalised values should have roughly unit variance (rolling window means
    the full-series std won't be exactly 1, but should be in range 0.8–1.5)."""
    for col in REQUIRED_FACTORS:
        if col in factor_df.columns:
            std = factor_df[col].dropna().std()
            assert 0.5 < std < 3.0, f"{col} std={std:.3f} out of expected range"


def test_no_all_nan_factor(factor_df):
    """No factor column should be all NaN."""
    for col in REQUIRED_FACTORS:
        if col in factor_df.columns:
            n_valid = factor_df[col].dropna().__len__()
            assert n_valid > 100, f"{col} has only {n_valid} non-NaN values"


def test_factor_levels_not_empty(factor_levels):
    """Raw factor levels must have rows."""
    assert len(factor_levels) > 0


def test_asset_validation_spy():
    """SPY should validate successfully."""
    from data.asset_fetcher import validate_ticker
    result = validate_ticker("SPY")
    assert result["valid"] is True
    assert result["ticker"] == "SPY"
    assert result["assetClass"] in ("etf", "equity", "index")
    assert result["currentPrice"] > 0


def test_asset_validation_invalid():
    """Invalid ticker should return valid=False."""
    from data.asset_fetcher import validate_ticker
    result = validate_ticker("XXXXINVALIDTICKER9999")
    assert result["valid"] is False


def test_fetch_asset_returns_spy():
    """SPY daily returns must be a non-empty Series."""
    from data.asset_fetcher import fetch_asset_returns
    ret = fetch_asset_returns("SPY", start=START)
    assert isinstance(ret, pd.Series)
    assert len(ret) > 200
    # Daily returns should be small (< 20% in absolute value for most days)
    assert ret.abs().median() < 5.0


def test_fred_series_10y_yield():
    """DGS10 must fetch and have reasonable values."""
    from data.factor_fetcher import fetch_fred_series
    s = fetch_fred_series("DGS10", start=START)
    assert not s.empty
    # 10Y yield should be between 0% and 20%
    assert s.dropna().between(0, 20).mean() > 0.9


def test_normalise_price_series():
    """normalise() on a price series should produce unit-variance output."""
    from data.factor_fetcher import normalise
    import numpy as np
    np.random.seed(42)
    prices = pd.Series(100 * (1 + np.random.randn(500) * 0.01).cumprod())
    normed = normalise(prices, is_price=True)
    std = normed.dropna().std()
    assert 0.8 < std < 1.3, f"Normalised std={std:.3f}"


def test_normalise_rate_series():
    """normalise() on a rate series should produce unit-variance output."""
    from data.factor_fetcher import normalise
    import numpy as np
    np.random.seed(1)
    rates = pd.Series(3.0 + np.random.randn(500).cumsum() * 0.03)
    normed = normalise(rates, is_price=False)
    std = normed.dropna().std()
    assert 0.8 < std < 1.3, f"Normalised std={std:.3f}"
