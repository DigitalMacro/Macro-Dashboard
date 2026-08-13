"""
Return and risk attribution computations for MFERM dashboard.
Builds on fit_plsr() output to produce time-series decompositions.
"""

import numpy as np
import pandas as pd
from typing import Optional
from models.plsr import fit_plsr, compute_factor_covariance, compute_risk_attribution


def compute_return_attribution(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    start: Optional[str] = None,
    end: Optional[str] = None,
    window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Compute full return attribution for the date range [start, end].

    Returns
    -------
    dict matching the /api/model/{ticker}/attribution JSON shape:
      dates, actual_return, factor_return, specific_return,
      factor_breakdown, summary, factors_used, factors_missing, n_factors
    """
    # Fit model on the most recent `window` trading days to get current exposures
    plsr_result = fit_plsr(factor_matrix, asset_returns, window=window,
                            expected_factors=expected_factors)
    exposures   = plsr_result["exposures"]

    # Align full history (not just the training window) for the display range
    aligned = factor_matrix.join(asset_returns.rename("asset"), how="inner").dropna()

    # Filter to requested date range
    if start:
        aligned = aligned[aligned.index >= pd.Timestamp(start)]
    if end:
        aligned = aligned[aligned.index <= pd.Timestamp(end)]

    # Re-compute factor return / specific return using current exposures
    # applied to the full display range
    factor_cols = [c for c in factor_matrix.columns if c in exposures.index]
    factor_ret   = (aligned[factor_cols] * exposures[factor_cols]).sum(axis=1)
    specific_ret = aligned["asset"] - factor_ret

    common_idx   = aligned.index

    # Per-factor daily contribution = exposure_i × factor_i_daily_return
    factor_cols = factor_matrix.columns.tolist()
    factor_breakdown = {}
    for col in factor_cols:
        if col in aligned.columns and col in exposures.index:
            contrib = exposures[col] * aligned[col]
            factor_breakdown[col] = contrib.tolist()

    dates = [d.strftime("%Y-%m-%d") for d in common_idx]

    # Cumulative summary
    total_ret    = float(aligned["asset"].sum())
    factor_sum   = float(factor_ret.sum())
    specific_sum = float(specific_ret.sum())

    return {
        "dates":           dates,
        "actual_return":   aligned["asset"].tolist(),
        "factor_return":   factor_ret.tolist(),
        "specific_return": specific_ret.tolist(),
        "factor_breakdown": factor_breakdown,
        "summary": {
            "total_return":    total_ret,
            "factor_return":   factor_sum,
            "specific_return": specific_sum,
            "rsquared":        plsr_result["rsquared"],
            "n_obs":           plsr_result["n_obs"],
        },
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }


def compute_point_risk(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    as_of: Optional[str] = None,
    window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Compute risk attribution as of a specific date.

    Returns
    -------
    dict matching /api/model/{ticker}/risk JSON shape:
      factor_vol, specific_vol, total_vol, factor_share, mctr,
      factors_used, factors_missing, n_factors
    """
    plsr_result = fit_plsr(factor_matrix, asset_returns, window=window,
                            expected_factors=expected_factors)
    exposures    = plsr_result["exposures"]
    specific_ret = plsr_result["specific_return"]

    # Daily specific vol (annualisation done inside compute_risk_attribution)
    specific_vol_daily = float(specific_ret.std())

    covar = compute_factor_covariance(factor_matrix)

    risk = compute_risk_attribution(exposures, covar, specific_vol_daily)

    return {
        "factor_vol":   round(risk["factor_vol"],   4),
        "specific_vol": round(risk["specific_vol"], 4),
        "total_vol":    round(risk["total_vol"],    4),
        "factor_share": round(risk["factor_share"], 4),
        "mctr":         {k: round(float(v), 6) for k, v in risk["mctr"].items()},
        "rsquared":     round(plsr_result["rsquared"], 4),
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }


def compute_rolling_risk(
    factor_matrix: pd.DataFrame,
    asset_returns: pd.Series,
    roll_window: int = 30,
    plsr_window: int = 250,
    expected_factors: Optional[list[str]] = None,
) -> dict:
    """
    Rolling 30-day factor vol vs specific vol time series.
    Used by the stacked area chart in View 2.
    """
    plsr_result  = fit_plsr(factor_matrix, asset_returns, window=plsr_window,
                             expected_factors=expected_factors)
    factor_ret   = plsr_result["factor_return"]
    specific_ret = plsr_result["specific_return"]

    # Rolling annualised vol
    factor_vol_ts   = factor_ret.rolling(roll_window).std() * np.sqrt(252)
    specific_vol_ts = specific_ret.rolling(roll_window).std() * np.sqrt(252)

    common = factor_vol_ts.dropna().index.intersection(specific_vol_ts.dropna().index)

    return {
        "dates":        [d.strftime("%Y-%m-%d") for d in common],
        "factor_vol":   factor_vol_ts.loc[common].tolist(),
        "specific_vol": specific_vol_ts.loc[common].tolist(),
        "factors_used":    plsr_result["factors_used"],
        "factors_missing": plsr_result["factors_missing"],
        "n_factors":       plsr_result["n_factors"],
        "n_obs":           plsr_result["n_obs"],
        "first_date":      plsr_result["first_date"],
    }
