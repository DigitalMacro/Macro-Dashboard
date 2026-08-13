"""
Asset Fetcher — fetches equity/ETF return series for the MFERM PLSR model.
The selected asset substitutes for Factor 13 (Market) as the y-variable.
"""

import yfinance as yf
import pandas as pd


def fetch_asset_returns(ticker: str, start: str = "2009-01-01") -> pd.Series:
    """
    Fetch daily % returns for any equity or ETF.
    This series substitutes for Factor 13 (Market) in the PLSR model.
    """
    t = yf.Ticker(ticker)
    hist = t.history(start=start, auto_adjust=True)
    if hist.empty:
        raise ValueError(f"No data found for ticker: {ticker}")
    returns = hist["Close"].pct_change(fill_method=None) * 100
    # Strip timezone so index aligns with FRED (tz-naive) data
    if returns.index.tz is not None:
        returns.index = returns.index.tz_localize(None)
    return returns.asfreq("B").ffill().dropna()


def validate_ticker(ticker: str) -> dict:
    """Check ticker is valid and return metadata."""
    try:
        t = yf.Ticker(ticker.upper())
        info = t.info
        if "regularMarketPrice" not in info and "currentPrice" not in info:
            # Try fetching history as a fallback check
            hist = t.history(period="5d")
            if hist.empty:
                return {"valid": False, "error": "Ticker not found"}
        return {
            "valid": True,
            "ticker": ticker.upper(),
            "name": info.get("longName", info.get("shortName", ticker.upper())),
            "sector": info.get("sector", info.get("category", "N/A")),
            "assetClass": _classify_asset(info),
            "currentPrice": info.get("regularMarketPrice",
                                      info.get("currentPrice",
                                               info.get("previousClose", 0))),
            "currency": info.get("currency", "USD"),
        }
    except Exception as e:
        return {"valid": False, "error": str(e)}


def _classify_asset(info: dict) -> str:
    qt = info.get("quoteType", "").lower()
    if qt == "etf":
        return "etf"
    if qt in ("equity", "stock"):
        return "equity"
    return "index"
