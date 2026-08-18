"""
MFERM Factor Fetcher — implements all 12 macro factors per data spec.
"""

import logging
import os
import pandas as pd
import numpy as np
import yfinance as yf
from fredapi import Fred
from typing import Optional

logger = logging.getLogger(__name__)

FRED_API_KEY = os.environ.get("FRED_API_KEY")
# Requested floor — most series (Treasuries, VIX, Baa/Aaa spreads) resolve
# back to 1990-03-27 or earlier. The fully-joined 12-factor matrix does NOT
# see 1990, though: inflation (T5YIE) and real_rates (DFII10) are both
# TIPS-derived and only start 2003-01-02 — the U.S. TIPS market itself
# doesn't have reliable 5Y breakevens/10Y real yields before then. Every
# factor is inner-joined and normalise()'s rolling-std needs a ~60-business-
# day warmup, so these two alone cap the fully-joined window at 2003-03-27
# regardless of this constant. dm_fx (DX-Y.NYB) is NOT the binding
# constraint — confirmed 2026-08-17 when swapping dm_fx off DTWEXBGS (which
# *was* the binding constraint, at 2006-03-27, before that swap).
# Don't assume 1990-01-01 here means the model sees 1990 — it means the
# request asks for 1990; T5YIE/DFII10 are what actually decide what comes
# back. See TODO.md for the pre-2003 history question (replacing the
# TIPS-derived factors) — a materially larger question than any single
# series swap, not yet evaluated.
START_DATE   = "1990-01-01"
NORM_WINDOW  = 250  # MFERM whitepaper §2.3

fred = Fred(api_key=FRED_API_KEY)

# ── FRED series map ─────────────────────────────────────────────────────────
FRED_SERIES = {
    "DGS1":          "1Y Treasury CMT",
    "DGS2":          "2Y Treasury CMT",
    "DGS5":          "5Y Treasury CMT",
    "DGS10":         "10Y Treasury CMT",
    "DGS30":         "30Y Treasury CMT",
    "DFII10":        "10Y TIPS Real Yield",
    "T5YIE":         "5Y Breakeven Inflation",
    "T10YIE":        "10Y Breakeven Inflation",
    "T5YIFR":        "5Y5Y Fwd Inflation",
    "THREEFF1":      "1Y Fitted Fwd Rate",
    "BAA10Y":        "Moody's Baa Spread to 10Y Treasury",
    "VIXCLS":        "VIX (FRED)",
    "CFNAI":         "Chicago Fed CFNAI",
    "DCOILWTICO":    "WTI Crude (FRED)",
}

# ── Yahoo Finance tickers ────────────────────────────────────────────────────
YAHOO_TICKERS = {
    "CL=F":     "WTI Crude (front month)",
    "HG=F":     "Copper (front month)",
    "^VIX":     "VIX",
    "^GSPC":    "S&P 500",
    "^MOVE":    "MOVE Index",
    "DX-Y.NYB": "DXY Dollar Index",
}


def fetch_fred_series(series_id: str, start: str = START_DATE,
                      _retries: int = 3, _delay: float = 5.0) -> pd.Series:
    """Fetch a single FRED series, forward-fill weekends. Retries on transient errors."""
    import time
    last_exc = None
    for attempt in range(_retries):
        try:
            s = fred.get_series(series_id, observation_start=start)
            return s.asfreq("B").ffill()
        except Exception as e:
            last_exc = e
            if attempt < _retries - 1:
                time.sleep(_delay * (attempt + 1))
    raise last_exc


GAP_THRESHOLD_BUSINESS_DAYS = 5  # ~1 trading week; below this is routine holiday noise


def longest_business_day_gap(series: pd.Series, window_start, window_end) -> int:
    """
    Longest run of consecutive missing business days for `series` within
    [window_start, window_end]. Shared by fetch_yahoo()'s logging check and
    model_service.exclude_currently_gapped() — one gap definition, two
    consumers, so the threshold can't drift between them.
    """
    expected = pd.bdate_range(window_start, window_end)
    if len(expected) == 0:
        return 0
    present = set(pd.DatetimeIndex(series.dropna().index).normalize())
    missing_mask = ~expected.isin(present)
    longest = current = 0
    for is_missing in missing_mask:
        if is_missing:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def fetch_yahoo(ticker: str, start: str = START_DATE,
                 _retries: int = 3, _delay: float = 5.0) -> pd.Series:
    """Fetch Yahoo Finance close price series. Retries on transient errors."""
    import time
    last_exc: Optional[Exception] = None
    for attempt in range(_retries):
        try:
            df = yf.download(ticker, start=start, progress=False, auto_adjust=True)
            if df.empty:
                raise ValueError(f"yfinance returned no rows for {ticker}")
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            # Only squeeze an actual single-column DataFrame down to a
            # Series. A bare .squeeze() (or squeeze("columns") applied
            # unconditionally) can instead collapse a single-*row* response
            # — seen under yfinance rate-limiting — down to a bare scalar,
            # which breaks every caller expecting a Series.
            s = df["Close"]
            if isinstance(s, pd.DataFrame):
                s = s.squeeze("columns")
            if not isinstance(s, pd.Series):
                raise TypeError(
                    f"Expected Series for {ticker}['Close'], got {type(s).__name__}"
                )
            # A shape-valid but suspiciously short response (seen live: a
            # single row for a 15+-year request) is itself a symptom of
            # yfinance rate-limiting, not a real result — retry rather than
            # silently modeling on starved data.
            if len(s) < 20:
                raise ValueError(
                    f"Suspiciously few rows ({len(s)}) for {ticker} since {start} "
                    "— likely a rate-limited/degenerate response"
                )
            # Strip timezone so index aligns with FRED (tz-naive) data
            if s.index.tz is not None:
                s.index = s.index.tz_localize(None)
            # Log-only: a hole in the middle of an otherwise-normal response
            # (confirmed live on ^MOVE, 2026-07-20 to 2026-08-12 — real
            # vendor gap, not a fetch bug, see TODO.md item 5). Retrying
            # doesn't help this class of failure, so this doesn't raise —
            # it surfaces via the log and, for current-window model fits,
            # via exclude_currently_gapped()/factors_missing instead.
            gap = longest_business_day_gap(s, s.index.min(), s.index.max())
            if gap >= GAP_THRESHOLD_BUSINESS_DAYS:
                logger.warning(
                    "%s has a %d-business-day gap somewhere in its history "
                    "(%s to %s) — data present overall, but not contiguous",
                    ticker, gap, s.index.min().date(), s.index.max().date(),
                )
            return s
        except Exception as e:
            last_exc = e
            logger.warning(
                "Yahoo fetch failed for %s (attempt %d/%d): %s",
                ticker, attempt + 1, _retries, e,
            )
            if attempt < _retries - 1:
                time.sleep(_delay * (attempt + 1))
    raise last_exc


def normalise(series: pd.Series,
              is_price: bool = False,
              window: int = NORM_WINDOW) -> pd.Series:
    """
    Daily change then rolling standardisation to unit variance.
    is_price=True  → pct_change * 100 (price-return series)
    is_price=False → diff()            (rate/spread series, already in %)
    """
    daily = series.pct_change(fill_method=None) * 100 if is_price else series.diff()
    std   = daily.rolling(window, min_periods=60).std()
    result = (daily / std).replace([float("inf"), float("-inf")], pd.NA)
    return result


def build_factor_dataframe(start: str = START_DATE) -> pd.DataFrame:
    """
    Fetch all 12 MFERM US factors and return a normalised DataFrame.
    Column names match Qi factor labels.
    """
    raw = {}

    # FRED fetches
    for sid in FRED_SERIES:
        try:
            raw[sid] = fetch_fred_series(sid, start)
        except Exception as e:
            logger.warning("FRED %s failed: %s", sid, e)
            raw[sid] = pd.Series(dtype=float)

    # Yahoo fetches
    for ticker in YAHOO_TICKERS:
        try:
            raw[ticker] = fetch_yahoo(ticker, start)
        except Exception as e:
            logger.warning("Yahoo %s failed: %s", ticker, e)
            raw[ticker] = pd.Series(dtype=float)

    # ── Factor derivations ───────────────────────────────────────────────────
    # Collect columns in a dict and build the DataFrame once at the end:
    # assigning to an empty DataFrame column-by-column freezes the index at the
    # FIRST column's index, silently truncating every later column to it.
    factors: dict = {}

    # F1: Economic Growth (CFNAI as daily-interpolated proxy)
    cfnai = raw.get("CFNAI", pd.Series(dtype=float))
    if not cfnai.empty:
        cfnai_daily = cfnai.resample("B").ffill()
        # Extend flat to today: CFNAI publishes monthly with a lag, and a stale
        # last obs would otherwise truncate the whole matrix via row dropna().
        full_idx = pd.bdate_range(cfnai_daily.index.min(), pd.Timestamp.today().normalize())
        cfnai_daily = cfnai_daily.reindex(full_idx).ffill()
        factors["economic_growth"] = normalise(cfnai_daily)

    # F2: Metals (Copper front-month return)
    hgf = raw.get("HG=F", pd.Series(dtype=float))
    if not hgf.empty:
        factors["metals"] = normalise(hgf, is_price=True)

    # F3: Energy (WTI crude return)
    clf = raw.get("CL=F", pd.Series(dtype=float))
    wti_fred = raw.get("DCOILWTICO", pd.Series(dtype=float))
    if not clf.empty:
        factors["energy"] = normalise(clf, is_price=True)
    elif not wti_fred.empty:
        factors["energy"] = normalise(wti_fred, is_price=True)

    # F4: Forward Growth Expectations (5s30s Treasury spread)
    dgs30 = raw.get("DGS30", pd.Series(dtype=float))
    dgs5  = raw.get("DGS5",  pd.Series(dtype=float))
    if not dgs30.empty and not dgs5.empty:
        fwd_growth_raw = (dgs30 - dgs5).dropna()
        factors["fwd_growth_expectations"] = normalise(fwd_growth_raw)

    # F5: Inflation (5Y TIPS breakeven — use diff not pct_change)
    t5yie = raw.get("T5YIE", pd.Series(dtype=float))
    if not t5yie.empty:
        factors["inflation"] = normalise(t5yie)

    # F6: IG Credit Spread (Moody's Baa spread to 10Y Treasury).
    # Was BAMLH0A0HYM2 (ICE BofA HY OAS) — that series only resolves back to
    # 2023-08-14 via FRED's API (ICE licensing restriction on this key, not
    # a fetch bug — confirmed against FRED's raw REST endpoint directly).
    # BAA10Y has full history and is investment-grade rather than high-yield
    # (0.63 correlation to the old series over the overlapping window) —
    # renamed from corporate_credit to ig_credit_spread to not imply HY.
    baa10y = raw.get("BAA10Y", pd.Series(dtype=float))
    if not baa10y.empty:
        factors["ig_credit_spread"] = normalise(baa10y)

    # F7: 10Y Yield (nominal Treasury)
    dgs10 = raw.get("DGS10", pd.Series(dtype=float))
    if not dgs10.empty:
        factors["10y_yield"] = normalise(dgs10)

    # F8: Real Rates (10Y TIPS real yield)
    dfii10 = raw.get("DFII10", pd.Series(dtype=float))
    if not dfii10.empty:
        factors["real_rates"] = normalise(dfii10)

    # F9: CB Rate Expectations (THREEFF1 − DGS1 spread)
    threeff1 = raw.get("THREEFF1", pd.Series(dtype=float))
    dgs1     = raw.get("DGS1",     pd.Series(dtype=float))
    if not threeff1.empty and not dgs1.empty:
        dgs1_aligned = dgs1.reindex(threeff1.index, method="ffill")
        cb_rt = (threeff1 - dgs1_aligned).dropna()
        factors["cb_rate_expectations"] = normalise(cb_rt)

    # F10: DM FX (DXY return). Was DTWEXBGS (FRED, trade-weighted, includes
    # EM currencies) — swapped 2026-08-17 for two reasons: DTWEXBGS was the
    # single binding constraint on the fully-joined matrix (2006-03-27), and
    # "dm_fx" claimed a developed-markets-only measure DTWEXBGS didn't
    # provide. DX-Y.NYB (ICE DXY) is genuinely DM-only (EUR/JPY/GBP/CAD/
    # SEK/CHF) so the name is now accurate, and it clears the 2006
    # constraint entirely (Yahoo history back to 1990+). Correlation to the
    # DTWEXBGS-derived factor it replaces: 0.73 Pearson / 0.72 Spearman over
    # the 2006-2026 overlap — see TODO.md for the full writeup, including
    # the ~58% EUR concentration this trades off against DTWEXBGS's broader
    # basket. DTWEXM (FRED, trade-weighted, DM-only) was evaluated and
    # rejected: discontinued by the Fed as of 2019-12-31, so it can't serve
    # a current-window fit regardless of its better composition.
    dxy = raw.get("DX-Y.NYB", pd.Series(dtype=float))
    if not dxy.empty:
        factors["dm_fx"] = normalise(dxy, is_price=True)

    # F11: Rate Volatility (normalised MOVE index level — not QT-specific;
    # renamed from cb_qt_expectations, which claimed a QT signal this
    # derivation never isolated. See TODO.md item 5.)
    move = raw.get("^MOVE", pd.Series(dtype=float))
    if not move.empty:
        factors["rate_vol"] = normalise(move)

    # F12: Risk Aversion (VIX diff)
    vixcls = raw.get("VIXCLS", pd.Series(dtype=float))
    vix_yf = raw.get("^VIX",   pd.Series(dtype=float))
    if not vixcls.empty:
        factors["risk_aversion"] = normalise(vixcls)
    elif not vix_yf.empty:
        factors["risk_aversion"] = normalise(vix_yf)

    # F13: Market (S&P 500 return — for MACROMKT model variant)
    gspc = raw.get("^GSPC", pd.Series(dtype=float))
    if not gspc.empty:
        factors["market"] = normalise(gspc, is_price=True)

    return pd.DataFrame(factors).dropna(how="all")
