"""
Global Rates market adapters — backend/services/global_rates_service.py

One async adapter per market, all returning the same normalized shape so the
router's compute is market-agnostic. Adding a market = one adapter + one
MARKETS entry.

Source notes (verified live 2026-07-19):
  - US: FRED DGS2/DGS5/DGS10/DGS30 + DFF via shared fred_service.
  - DE: ECB Data Portal, YC dataset (euro-area AAA spot curve). The spec's
    primary FM dataset key (FM/B.U2.EUR.4F.BB.U2_2Y.YLD) 404s — the YC
    fallback keys work and are used. One small request per tenor (the
    SR_2Y+SR_5Y multi-key syntax over-matches and returns megabytes).
  - UK: BoE IADB CSV. The spec's series codes were wrong: IUDMNZC is the 10Y
    nominal zero-coupon (not 2Y) and IUDMRZC/IUDLRZC are REAL yields. Correct
    nominal set is IUDSNZC (5Y), IUDMNZC (10Y), IUDLNZC (20Y). The IADB
    publishes NO 2Y nominal zero-coupon series (the RNZC2 category is empty),
    so the UK short leg is 5Y and its slope is 5s10s, labeled honestly.
    Requires a browser User-Agent and redirect-following.
  - JP: MoF JGB CSV. jgbcme.csv only holds the CURRENT month; history lives in
    historical/jgbcme_all.csv, which is ~1.3MB served extremely slowly — the
    adapter issues an HTTP Range request for the file tail (server supports
    206) plus the current-month file, then merges.
"""

import io
import time
from datetime import datetime, timedelta
from typing import Callable, Optional

import httpx
import pandas as pd

from services.fred_service import fetch_fred_daily

TIMEOUT = 20
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# BoJ uncollateralized overnight call rate target.
# policy_rate_manual: no clean daily FRED series — update on BoJ policy changes.
# Current value set 2026-07-19 per BoJ statement of 2026-06-16 (raised to ~1.0%).
JP_POLICY_RATE = 1.00

ECB_YC_BASE = "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM"
BOE_BASE = "https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp"
JGB_ALL_URL = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv"
JGB_CURRENT_URL = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv"

JGB_COLUMNS = ["date", "1Y", "2Y", "3Y", "4Y", "5Y", "6Y", "7Y", "8Y", "9Y",
               "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"]


def _series_tail(s: pd.Series, lookback_days: int) -> pd.Series:
    cutoff = pd.Timestamp(datetime.today() - timedelta(days=lookback_days))
    return s[s.index >= cutoff]


def _snapshot(history: dict) -> dict:
    """Latest value per tenor from the history dict."""
    out = {}
    for tenor, s in history.items():
        s = s.dropna()
        if not s.empty:
            out[tenor] = round(float(s.iloc[-1]), 3)
    return out


def _as_of(history: dict) -> Optional[str]:
    dates = [s.dropna().index[-1] for s in history.values() if not s.dropna().empty]
    return max(dates).strftime("%Y-%m-%d") if dates else None


# ── US — FRED ─────────────────────────────────────────────────────────────────

async def fetch_us_yields(lookback_days: int = 400) -> dict:
    cal_days = int(lookback_days * 1.6)  # calendar cushion for business days
    import asyncio
    y2, y5, y10, y30, dff = await asyncio.gather(
        fetch_fred_daily("DGS2", cal_days),
        fetch_fred_daily("DGS5", cal_days),
        fetch_fred_daily("DGS10", cal_days),
        fetch_fred_daily("DGS30", cal_days),
        fetch_fred_daily("DFF", 60),
    )
    history = {"2Y": y2, "5Y": y5, "10Y": y10, "30Y": y30}
    return {
        "market": "US",
        "tenors": _snapshot(history),
        "history": history,
        "policy_rate": round(float(dff.dropna().iloc[-1]), 2) if not dff.dropna().empty else None,
        "as_of": _as_of(history),
        "source": "FRED (DGS2/5/10/30, DFF)",
    }


# ── DE — ECB Data Portal (YC dataset, AAA euro-area spot curve) ──────────────

async def _fetch_ecb_yc_tenor(client: httpx.AsyncClient, tenor_key: str, start: str) -> pd.Series:
    # startPeriod is ~15x faster than lastNObs on the YC dataset (verified live)
    url = f"{ECB_YC_BASE}.{tenor_key}?format=jsondata&startPeriod={start}"
    r = await client.get(url)
    r.raise_for_status()
    d = r.json()
    obs_dates = [v["id"] for v in d["structure"]["dimensions"]["observation"][0]["values"]]
    series = d["dataSets"][0]["series"]
    first = next(iter(series.values()))
    data = {
        pd.Timestamp(obs_dates[int(i)]): float(vals[0])
        for i, vals in first["observations"].items()
        if vals and vals[0] is not None
    }
    return pd.Series(data).sort_index()


async def fetch_de_yields(lookback_days: int = 400) -> dict:
    import asyncio
    start = (datetime.today() - timedelta(days=int(lookback_days * 1.6))).strftime("%Y-%m-%d")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        y2, y5, y10, y30 = await asyncio.gather(
            _fetch_ecb_yc_tenor(client, "SR_2Y", start),
            _fetch_ecb_yc_tenor(client, "SR_5Y", start),
            _fetch_ecb_yc_tenor(client, "SR_10Y", start),
            _fetch_ecb_yc_tenor(client, "SR_30Y", start),
        )
    policy = await fetch_fred_daily("ECBDFR", 60)
    history = {"2Y": y2, "5Y": y5, "10Y": y10, "30Y": y30}
    return {
        "market": "DE",
        "tenors": _snapshot(history),
        "history": history,
        "policy_rate": round(float(policy.dropna().iloc[-1]), 2) if not policy.dropna().empty else None,
        "as_of": _as_of(history),
        "source": "ECB Data Portal (YC AAA spot) · FRED ECBDFR",
    }


# ── UK — Bank of England IADB ─────────────────────────────────────────────────

UK_SERIES = {"IUDSNZC": "5Y", "IUDMNZC": "10Y", "IUDLNZC": "20Y"}
# Index-linked gilt real zero-coupon yields (verified live 2026-07-20: the FX
# spec's IUDMIZC/IUDMRIZ codes are invalid — the IADB real trio is S/M/L like
# the nominals, and no real series exists below 5Y).
UK_REAL_SERIES = {"IUDSRZC": "5Y", "IUDMRZC": "10Y", "IUDLRZC": "20Y"}
UK_POLICY_SERIES = "IUDBEDR"


async def fetch_uk_yields(lookback_days: int = 400) -> dict:
    datefrom = (datetime.today() - timedelta(days=int(lookback_days * 1.6))).strftime("%d/%b/%Y")
    codes = ",".join(
        list(UK_SERIES.keys()) + list(UK_REAL_SERIES.keys()) + [UK_POLICY_SERIES]
    )
    params = {
        "csv.x": "yes", "Datefrom": datefrom, "Dateto": "now",
        "SeriesCodes": codes, "CSVF": "TN", "UsingCodes": "Y", "VPD": "Y",
    }
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=UA, follow_redirects=True) as client:
        r = await client.get(BOE_BASE, params=params)
        r.raise_for_status()

    df = pd.read_csv(io.StringIO(r.text))
    df.columns = [c.strip() for c in df.columns]
    df["DATE"] = pd.to_datetime(df["DATE"], format="%d %b %Y")
    df = df.set_index("DATE").sort_index()

    history = {
        tenor: pd.to_numeric(df[code], errors="coerce").dropna()
        for code, tenor in UK_SERIES.items()
        if code in df.columns
    }
    real_history = {
        tenor: pd.to_numeric(df[code], errors="coerce").dropna()
        for code, tenor in UK_REAL_SERIES.items()
        if code in df.columns
    }
    policy = None
    if UK_POLICY_SERIES in df.columns:
        p = pd.to_numeric(df[UK_POLICY_SERIES], errors="coerce").dropna()
        if not p.empty:
            policy = round(float(p.iloc[-1]), 2)

    return {
        "market": "UK",
        "tenors": _snapshot(history),
        "history": history,
        "real_history": real_history,  # index-linked gilt real yields, 5/10/20Y
        "policy_rate": policy,
        "as_of": _as_of(history),
        "source": "BoE IADB (nominal + real ZC 5/10/20Y, Bank Rate)",
    }


# ── JP — Ministry of Finance JGB CSV ─────────────────────────────────────────

def _parse_jgb_csv(text: str, has_header: bool) -> pd.DataFrame:
    rows = []
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) != len(JGB_COLUMNS):
            continue
        if not parts[0] or "/" not in parts[0]:
            continue  # header / junk / partial first line of a ranged fetch
        rows.append(parts)
    df = pd.DataFrame(rows, columns=JGB_COLUMNS)
    df["date"] = pd.to_datetime(df["date"], format="%Y/%m/%d", errors="coerce")
    df = df.dropna(subset=["date"]).set_index("date")
    for c in df.columns:
        df[c] = pd.to_numeric(df[c].replace("-", None), errors="coerce")
    return df


async def fetch_jp_yields(lookback_days: int = 400) -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
        # Tail of the (very slowly served) full-history file via Range request
        # — ~120KB covers well over 400 business days.
        r_hist = await client.get(JGB_ALL_URL, headers={"Range": "bytes=-120000"})
        r_cur = await client.get(JGB_CURRENT_URL)

    frames = []
    if r_hist.status_code in (200, 206):
        frames.append(_parse_jgb_csv(r_hist.text, has_header=False))
    if r_cur.status_code == 200:
        frames.append(_parse_jgb_csv(r_cur.text, has_header=True))
    if not frames:
        raise RuntimeError("JGB CSV fetch failed for both history and current files")

    df = pd.concat(frames)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df[df.index >= pd.Timestamp(datetime.today() - timedelta(days=int(lookback_days * 1.6)))]

    history = {t: df[t].dropna() for t in ["2Y", "5Y", "10Y", "30Y"] if t in df.columns}
    return {
        "market": "JP",
        "tenors": _snapshot(history),
        "history": history,
        "policy_rate": JP_POLICY_RATE,
        "policy_rate_manual": True,
        "as_of": _as_of(history),
        "source": "MoF JGB par yields · BoJ target (manual)",
    }


# ── Shared adapter-level cache ────────────────────────────────────────────────
# Both the global-rates and fx routers pull market data through this — one
# fetching path, one cache. TTL 4h (daily-close sources).

_ADAPTER_TTL = 4 * 3600
_adapter_cache: dict = {}


async def fetch_market_cached(code: str, lookback_days: int = 400) -> dict:
    key = (code, lookback_days)
    now = time.time()
    hit = _adapter_cache.get(key)
    if hit and now - hit[1] < _ADAPTER_TTL:
        return hit[0]
    data = await MARKETS[code]["adapter"](lookback_days)
    _adapter_cache[key] = (data, now)
    return data


# ── Market registry ───────────────────────────────────────────────────────────
# Adding a market = one adapter above + one entry here.

MARKETS: dict = {
    "US": {"name": "United States",  "adapter": fetch_us_yields, "color": "#F0F0F0",
           "policy_source": "FRED:DFF",     "policy_label": "FED", "short_tenor": "2Y"},
    "DE": {"name": "Euro Area",      "adapter": fetch_de_yields, "color": "#38bdf8",
           "policy_source": "FRED:ECBDFR",  "policy_label": "ECB", "short_tenor": "2Y"},
    "UK": {"name": "United Kingdom", "adapter": fetch_uk_yields, "color": "#f59e0b",
           "policy_source": "BoE:IUDBEDR",  "policy_label": "BOE", "short_tenor": "5Y"},
    "JP": {"name": "Japan",          "adapter": fetch_jp_yields, "color": "#f87171",
           "policy_source": "manual",       "policy_label": "BOJ", "short_tenor": "2Y"},
}
