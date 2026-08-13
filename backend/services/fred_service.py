"""
Shared async FRED fetch helpers — backend/services/fred_service.py
Consolidates the duplicated fetchers from routers/regime.py and
routers/yield_curve.py. Behavior identical to the originals.
"""

import os
from datetime import datetime, timedelta
from typing import Optional

import httpx
import pandas as pd

FRED_API_KEY = os.getenv("FRED_API_KEY", "")
FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"


async def _fetch(series_id: str, lookback_days: int, frequency: Optional[str]) -> pd.Series:
    start = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    params = {
        "series_id": series_id,
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "observation_start": start,
    }
    if frequency:
        params["frequency"] = frequency
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(FRED_BASE, params=params)
        r.raise_for_status()
    obs = r.json().get("observations", [])
    data = {o["date"]: float(o["value"]) for o in obs if o["value"] != "."}
    s = pd.Series(data)
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


async def fetch_fred(series_id: str, lookback_days: int = 3650) -> pd.Series:
    """Monthly-aggregated series (regime module's original fetch_fred).
    10y lookback: the 36-month rolling z-scores need ≥36 monthly observations."""
    return await _fetch(series_id, lookback_days, frequency="m")


async def fetch_fred_daily(series_id: str, lookback_days: int = 1460) -> pd.Series:
    """Native-frequency (daily) series (yield_curve module's original fetch_fred_daily)."""
    return await _fetch(series_id, lookback_days, frequency=None)
