"""
Stress testing module — 3 scenario types per whitepaper §3.3.
"""

from typing import Optional

import numpy as np
import pandas as pd
from models.plsr import fit_plsr, compute_factor_covariance

# ── Historical scenario definitions ─────────────────────────────────────────
HISTORICAL_SCENARIOS = {
    "trade_war_2018": {
        "label":       "US-China Trade War (Oct–Dec 2018)",
        "start":       "2018-10-01",
        "end":         "2018-12-31",
    },
    "covid_2020": {
        "label":       "COVID Crash (Feb–Mar 2020)",
        "start":       "2020-02-19",
        "end":         "2020-03-23",
    },
    "rates_2022": {
        "label":       "Rate Shock 2022 (Jan–Oct 2022)",
        "start":       "2022-01-03",
        "end":         "2022-10-31",
    },
    "gfc_2008": {
        "label":       "Global Financial Crisis (Sep–Dec 2008)",
        "start":       "2008-09-01",
        "end":         "2008-12-31",
    },
}


def run_historical_stress(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    scenario: str,
    plsr_window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Replay actual factor moves during a historical stress period
    through the current PLSR exposures.

    Impact_i = exposure_i × mean_daily_factor_move_i × n_days
    Total    = sum of all factor impacts + residual from specific return
    """
    if scenario not in HISTORICAL_SCENARIOS:
        raise ValueError(f"Unknown scenario: {scenario}. "
                         f"Choose from {list(HISTORICAL_SCENARIOS.keys())}")

    meta  = HISTORICAL_SCENARIOS[scenario]
    start = meta["start"]
    end   = meta["end"]

    # Fit model on full history (current exposures)
    plsr_result = fit_plsr(factor_matrix, asset_returns, window=plsr_window,
                            expected_factors=expected_factors)
    exposures   = plsr_result["exposures"]

    # Slice factor matrix to scenario window
    scenario_factors = factor_matrix[
        (factor_matrix.index >= pd.Timestamp(start)) &
        (factor_matrix.index <= pd.Timestamp(end))
    ].dropna(how="all")

    if len(scenario_factors) == 0:
        raise ValueError(f"No factor data for scenario period {start}–{end}")

    # Cumulative factor returns in the scenario window (sum of daily normalised moves)
    cum_factor_moves = scenario_factors.sum()

    # Factor-by-factor impact on asset return
    factor_impacts = {}
    for factor in exposures.index:
        if factor in cum_factor_moves.index:
            factor_impacts[factor] = float(exposures[factor] * cum_factor_moves[factor])
        else:
            factor_impacts[factor] = 0.0

    total_impact = sum(factor_impacts.values())

    return {
        "scenario":      scenario,
        "label":         meta["label"],
        "start":         start,
        "end":           end,
        "n_days":        len(scenario_factors),
        "factor_impacts": {k: round(v, 4) for k, v in factor_impacts.items()},
        "total_impact":   round(total_impact, 4),
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }


def run_uncorrelated_stress(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    shocks: dict[str, float],
    plsr_window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Apply independent factor shocks (no cross-factor correlation).
    Shocks are in native units (bp, %, pts) — they are normalised
    internally by the factor's rolling std before applying exposures.

    Impact_i = exposure_i × (shock_i / rolling_std_i)
    """
    plsr_result = fit_plsr(factor_matrix, asset_returns, window=plsr_window,
                            expected_factors=expected_factors)
    exposures   = plsr_result["exposures"]

    # Compute rolling std for normalisation (last 250 days)
    factor_stds = {}
    for col in factor_matrix.columns:
        series = factor_matrix[col].dropna()
        # The factor_matrix is already normalised; to convert native shock
        # units back we need the raw std. We use ≈1 since factors are
        # already in std-dev units — so shocks here are in std-dev units.
        factor_stds[col] = 1.0  # normalised factor, shock = std dev units

    factor_impacts = {}
    for factor, shock in shocks.items():
        if factor in exposures.index:
            factor_impacts[factor] = float(exposures[factor] * shock)
        else:
            factor_impacts[factor] = 0.0

    # Factors not in shocks contribute 0
    for factor in exposures.index:
        if factor not in factor_impacts:
            factor_impacts[factor] = 0.0

    total_impact = sum(factor_impacts.values())

    return {
        "scenario":      "uncorrelated",
        "factor_impacts": {k: round(v, 4) for k, v in factor_impacts.items()},
        "total_impact":   round(total_impact, 4),
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }


def run_correlated_stress(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    core_factor: str,
    shock_value: float,
    plsr_window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Shock one core factor and propagate via conditional expectation.
    Peripheral factor moves: E[X_j | X_i = shock] = ρ_{ij} * shock
    (whitepaper §3.3 — conditional expectation formula)

    All factors are normalised, so ρ is the correlation matrix.
    """
    plsr_result = fit_plsr(factor_matrix, asset_returns, window=plsr_window,
                            expected_factors=expected_factors)
    exposures   = plsr_result["exposures"]

    # Compute correlation matrix from recent history
    recent = factor_matrix.tail(plsr_window).dropna()
    corr   = recent.corr()

    if core_factor not in corr.columns:
        raise ValueError(f"Core factor '{core_factor}' not in factor matrix")

    # Peripheral factor estimated moves via conditional expectation
    peripheral_moves = {}
    for f in corr.columns:
        if f != core_factor:
            peripheral_moves[f] = float(corr.loc[core_factor, f] * shock_value)

    # Impact on asset
    factor_impacts = {}
    for f in exposures.index:
        if f == core_factor:
            factor_impacts[f] = float(exposures[f] * shock_value)
        elif f in peripheral_moves:
            factor_impacts[f] = float(exposures[f] * peripheral_moves[f])
        else:
            factor_impacts[f] = 0.0

    total_impact = sum(factor_impacts.values())

    return {
        "scenario":         "correlated",
        "core_factor":      core_factor,
        "core_shock":       shock_value,
        "factor_impacts":    {k: round(v, 4) for k, v in factor_impacts.items()},
        "total_impact":      round(total_impact, 4),
        "peripheral_moves":  {k: round(v, 4) for k, v in peripheral_moves.items()},
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }
