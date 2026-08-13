"""
MFERM PLSR Model — implements PLSR per whitepaper Appendix (i).
Wraps scikit-learn PLSRegression with correct lookback windows and
exposure calculation as specified in §2.2 and §2.3.
"""

from typing import Optional

from sklearn.cross_decomposition import PLSRegression
import numpy as np
import pandas as pd

REGRESSION_WINDOW = 250   # §2.3: 1 year lookback
N_COMPONENTS      = 3     # §2.2: first 3 latent vectors only
COVAR_WINDOW      = 125   # §2.3: 6 months
COVAR_HALFLIFE    = 90    # trading days, 90d half-life


def fit_plsr(factor_matrix: pd.DataFrame,
             asset_returns: pd.Series,
             window: int = REGRESSION_WINDOW,
             expected_factors: Optional[list[str]] = None) -> dict:
    """
    Fit PLSR model for a single asset over the most recent `window` days.
    Returns factor exposures (betas) and model fit statistics.

    Parameters
    ----------
    factor_matrix    : normalised daily factor returns, shape (T, n)
    asset_returns    : daily % returns for the target asset, shape (T,)
    window           : lookback in trading days
    expected_factors : the full canonical factor list this fit was supposed
                        to run on. When provided, any name in this list not
                        present in factor_matrix.columns is reported back as
                        missing — upstream data drops a factor silently
                        (source fetch failed), and PLSR redistributes its
                        variance across whichever factors survive, so this
                        is a signal about the whole fit, not one column.

    Returns
    -------
    dict with keys:
      exposures       : pd.Series — factor sensitivity (% chg per 1 std dev)
      rsquared        : float — in-sample R²
      factor_return   : pd.Series — fitted factor return component
      specific_return : pd.Series — residual (idiosyncratic) component
      n_obs           : int — number of observations used
      window_days     : int — requested window
      factors_used    : list[str] — factors actually present in this fit
      factors_missing : list[str] — expected factors absent from this fit
      n_factors       : int — len(factors_used)
    """
    # Align and trim to window
    aligned = factor_matrix.join(asset_returns.rename("asset"), how="inner")
    aligned = aligned.dropna().tail(window)

    n_obs = len(aligned)
    if n_obs < 60:
        raise ValueError(
            f"Insufficient data for model: {n_obs} observations "
            f"(minimum 60 required)"
        )

    X = aligned[factor_matrix.columns].values
    y = aligned["asset"].values.reshape(-1, 1)

    # Use fewer components if we have very little data
    n_comp = min(N_COMPONENTS, n_obs - 1, X.shape[1])

    # Fit PLSR with exactly 3 latent vectors (whitepaper §2.2)
    pls = PLSRegression(n_components=n_comp, scale=False)
    pls.fit(X, y)

    # Factor exposures — coefficients in original factor units
    exposures = pd.Series(
        pls.coef_.flatten(),
        index=factor_matrix.columns
    )

    # Predicted (factor) return component
    y_hat = pls.predict(X).flatten()
    factor_ret = pd.Series(y_hat, index=aligned.index)

    # Specific (idiosyncratic) return component
    specific_ret = aligned["asset"] - factor_ret

    # R-squared
    ss_res = np.sum((aligned["asset"].values - y_hat) ** 2)
    ss_tot = np.sum((aligned["asset"].values - aligned["asset"].mean()) ** 2)
    rsq = 1.0 - ss_res / ss_tot if ss_tot != 0 else 0.0

    factors_used = list(factor_matrix.columns)
    factors_missing = (
        [f for f in expected_factors if f not in factors_used]
        if expected_factors else []
    )

    return {
        "exposures":       exposures,
        "rsquared":        float(rsq),
        "factor_return":   factor_ret,
        "specific_return": specific_ret,
        "n_obs":           n_obs,
        "window_days":     window,
        "factors_used":    factors_used,
        "factors_missing": factors_missing,
        "n_factors":       len(factors_used),
        "first_date":      aligned.index.min().strftime("%Y-%m-%d") if n_obs else None,
    }


def compute_factor_covariance(factor_matrix: pd.DataFrame,
                               window: int = COVAR_WINDOW,
                               halflife: int = COVAR_HALFLIFE) -> pd.DataFrame:
    """
    Exponentially-weighted factor covariance matrix.
    §2.3: 125-day window, 90-day half-life.
    """
    recent = factor_matrix.tail(window).dropna()
    # ewm().cov() returns a MultiIndex DataFrame; get the last block
    cov_full = recent.ewm(halflife=halflife).cov()
    n_factors = len(factor_matrix.columns)
    return cov_full.iloc[-n_factors:].droplevel(0)


def compute_risk_attribution(exposures: pd.Series,
                              covar: pd.DataFrame,
                              specific_vol: float) -> dict:
    """
    Decompose total annualised volatility into factor and specific components.
    σ²_total  = σ²_factor + σ²_specific
    σ²_factor = X' Σ X   (daily variance, then annualised × √252)
    """
    # Align covar to exposure index
    common = exposures.index.intersection(covar.index).intersection(covar.columns)
    x = exposures[common].values
    sigma_f = covar.loc[common, common].values

    factor_var = float(x @ sigma_f @ x)
    specific_var = specific_vol ** 2
    total_var = factor_var + specific_var

    factor_vol_ann    = np.sqrt(max(factor_var,    0)) * np.sqrt(252)
    specific_vol_ann  = np.sqrt(max(specific_var,  0)) * np.sqrt(252)
    total_vol_ann     = np.sqrt(max(total_var,     0)) * np.sqrt(252)

    # Per-factor marginal contribution to risk (daily, then annualised)
    denom = np.sqrt(max(factor_var, 1e-10))
    mctr_values = (sigma_f @ x) / denom * np.sqrt(252) * exposures[common].values
    mctr = pd.Series(mctr_values, index=common)

    return {
        "factor_vol":   factor_vol_ann,
        "specific_vol": specific_vol_ann,
        "total_vol":    total_vol_ann,
        "factor_share": float(factor_var / max(total_var, 1e-10)),
        "mctr":         mctr,
    }
