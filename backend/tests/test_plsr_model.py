"""
Phase 2 tests — PLSR model, attribution, and stress testing.
Run with: pytest tests/test_plsr_model.py -v
"""

import os
import sys
import pytest
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

START       = "2020-01-01"  # for most tests (fast)
START_FULL  = "2009-01-01"  # for historical stress tests (needs 2018+ data)

FACTOR_COLS = [
    "economic_growth", "metals", "energy", "fwd_growth_expectations",
    "inflation", "ig_credit_spread", "10y_yield", "real_rates",
    "cb_rate_expectations", "dm_fx", "rate_vol", "risk_aversion",
]


@pytest.fixture(scope="module")
def factor_matrix():
    from data.factor_fetcher import build_factor_dataframe
    df = build_factor_dataframe(start=START)
    return df[FACTOR_COLS].dropna()


@pytest.fixture(scope="module")
def spy_returns():
    from data.asset_fetcher import fetch_asset_returns
    return fetch_asset_returns("SPY", start=START)


@pytest.fixture(scope="module")
def plsr_result(factor_matrix, spy_returns):
    from models.plsr import fit_plsr
    return fit_plsr(factor_matrix, spy_returns)


# ── PLSR core ────────────────────────────────────────────────────────────────

def test_plsr_returns_all_keys(plsr_result):
    for key in ("exposures", "rsquared", "factor_return", "specific_return",
                "n_obs", "window_days"):
        assert key in plsr_result, f"Missing key: {key}"


def test_plsr_exposures_shape(plsr_result):
    exp = plsr_result["exposures"]
    assert len(exp) == len(FACTOR_COLS), (
        f"Expected {len(FACTOR_COLS)} exposures, got {len(exp)}"
    )
    assert list(exp.index) == FACTOR_COLS


def test_plsr_rsquared_reasonable(plsr_result):
    """SPY R² should be ~20-60% for the MFERM model."""
    rsq = plsr_result["rsquared"]
    print(f"\nSPY R² = {rsq:.3f}")
    assert 0.05 < rsq < 0.95, f"R²={rsq:.3f} looks wrong"


def test_plsr_factor_plus_specific_equals_actual(plsr_result, spy_returns):
    """factor_return + specific_return should equal actual asset return."""
    factor_ret   = plsr_result["factor_return"]
    specific_ret = plsr_result["specific_return"]
    reconstructed = factor_ret + specific_ret

    # Align to common index
    common = factor_ret.index.intersection(spy_returns.index)
    diff = (reconstructed.loc[common] - spy_returns.loc[common]).abs()
    assert diff.max() < 1e-8, f"Max reconstruction error: {diff.max()}"


def test_plsr_risk_aversion_sign(plsr_result):
    """SPY should have negative exposure to risk_aversion (VIX)."""
    exp = plsr_result["exposures"]
    print(f"\nrisk_aversion exposure: {exp['risk_aversion']:.4f}")
    assert exp["risk_aversion"] < 0, (
        f"SPY should be negatively exposed to risk_aversion, got {exp['risk_aversion']:.4f}"
    )


def test_plsr_n_obs(plsr_result):
    assert plsr_result["n_obs"] >= 60
    assert plsr_result["n_obs"] <= 250


# ── Covariance matrix ────────────────────────────────────────────────────────

def test_covariance_is_psd(factor_matrix):
    from models.plsr import compute_factor_covariance
    cov = compute_factor_covariance(factor_matrix)
    eigvals = np.linalg.eigvalsh(cov.values)
    assert (eigvals >= -1e-8).all(), f"Covariance not PSD, min eigenvalue: {eigvals.min()}"


def test_covariance_shape(factor_matrix):
    from models.plsr import compute_factor_covariance
    cov = compute_factor_covariance(factor_matrix)
    n = len(FACTOR_COLS)
    assert cov.shape == (n, n), f"Expected ({n},{n}), got {cov.shape}"


# ── Risk attribution ─────────────────────────────────────────────────────────

def test_risk_attribution_vols_positive(factor_matrix, plsr_result):
    from models.plsr import compute_factor_covariance, compute_risk_attribution
    exposures    = plsr_result["exposures"]
    specific_vol = float(plsr_result["specific_return"].std())
    covar        = compute_factor_covariance(factor_matrix)

    risk = compute_risk_attribution(exposures, covar, specific_vol)
    assert risk["factor_vol"]   >= 0
    assert risk["specific_vol"] >= 0
    assert risk["total_vol"]    >= 0
    print(f"\nFactor vol={risk['factor_vol']:.2%}, "
          f"Specific vol={risk['specific_vol']:.2%}, "
          f"Total={risk['total_vol']:.2%}, "
          f"Factor share={risk['factor_share']:.2%}")


def test_risk_factor_share_between_0_and_1(factor_matrix, plsr_result):
    from models.plsr import compute_factor_covariance, compute_risk_attribution
    exposures    = plsr_result["exposures"]
    specific_vol = float(plsr_result["specific_return"].std())
    covar        = compute_factor_covariance(factor_matrix)
    risk = compute_risk_attribution(exposures, covar, specific_vol)
    assert 0.0 <= risk["factor_share"] <= 1.0


# ── Attribution ──────────────────────────────────────────────────────────────

def test_return_attribution_keys(factor_matrix, spy_returns):
    from models.attribution import compute_return_attribution
    result = compute_return_attribution(factor_matrix, spy_returns,
                                        start="2024-01-01", end="2024-06-30")
    for key in ("dates", "actual_return", "factor_return", "specific_return",
                "factor_breakdown", "summary"):
        assert key in result, f"Missing key: {key}"


def test_return_attribution_lengths_match(factor_matrix, spy_returns):
    from models.attribution import compute_return_attribution
    result = compute_return_attribution(factor_matrix, spy_returns,
                                        start="2024-01-01", end="2024-06-30")
    n = len(result["dates"])
    assert len(result["actual_return"])   == n
    assert len(result["factor_return"])   == n
    assert len(result["specific_return"]) == n
    for factor, contribs in result["factor_breakdown"].items():
        assert len(contribs) == n, f"{factor} breakdown length mismatch"


# ── Stress testing ───────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def factor_matrix_full():
    from data.factor_fetcher import build_factor_dataframe
    df = build_factor_dataframe(start=START_FULL)
    return df[FACTOR_COLS].dropna()


@pytest.fixture(scope="module")
def spy_returns_full():
    from data.asset_fetcher import fetch_asset_returns
    return fetch_asset_returns("SPY", start=START_FULL)


def test_historical_stress_covid(factor_matrix_full, spy_returns_full):
    from models.stress import run_historical_stress
    result = run_historical_stress(factor_matrix_full, spy_returns_full, "covid_2020")
    assert "total_impact" in result
    assert "factor_impacts" in result
    print(f"\nCOVID stress total impact on SPY: {result['total_impact']:.2f}%")
    # COVID was a crash; SPY impact should be negative
    assert result["total_impact"] < 0, (
        f"Expected negative COVID impact, got {result['total_impact']:.4f}"
    )


def test_historical_stress_trade_war(factor_matrix_full, spy_returns_full):
    from models.stress import run_historical_stress
    result = run_historical_stress(factor_matrix_full, spy_returns_full, "trade_war_2018")
    assert result["total_impact"] is not None


def test_uncorrelated_stress(factor_matrix, spy_returns):
    from models.stress import run_uncorrelated_stress
    # Shock VIX up by 2 std devs — should hurt SPY
    shocks = {"risk_aversion": 2.0, "ig_credit_spread": 1.5}
    result = run_uncorrelated_stress(factor_matrix, spy_returns, shocks)
    assert "total_impact" in result
    assert result["total_impact"] < 0, (
        f"VIX shock + credit widening should be negative for SPY, "
        f"got {result['total_impact']:.4f}"
    )


def test_correlated_stress(factor_matrix, spy_returns):
    from models.stress import run_correlated_stress
    result = run_correlated_stress(
        factor_matrix, spy_returns,
        core_factor="risk_aversion", shock_value=2.0
    )
    assert "peripheral_moves" in result
    assert "total_impact" in result
    assert len(result["peripheral_moves"]) == len(FACTOR_COLS) - 1
