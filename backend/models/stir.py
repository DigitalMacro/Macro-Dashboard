"""
STIR compute functions — pure Python port of playbook appendix A3/A4/A5.
No I/O; feed DataFrames from stir_fetcher and get back plain dicts/lists.
"""
from __future__ import annotations

import math
from calendar import monthrange
from datetime import date

import pandas as pd


# ── A3: Implied rate & terminal detection ─────────────────────────────────────

def add_implied(strip: pd.DataFrame, ocr: float) -> pd.DataFrame:
    """Attach implied_rate and vs_ocr_bp columns to a strip DataFrame."""
    out = strip.copy()
    out["implied_rate"] = 100.0 - out["settle"]
    out["vs_ocr_bp"]    = (out["implied_rate"] - ocr) * 100.0
    return out


def find_terminal(strip_view: pd.DataFrame, ocr: float) -> dict:
    """
    Return the terminal contract (first rate peak if hiking, first trough if cutting).
    Filters out inactive (settle == 0) contracts before walking.
    Returns the matching row as a plain dict.
    """
    active = strip_view[strip_view["settle"] > 0].reset_index(drop=True)
    if active.empty:
        return strip_view.iloc[0].to_dict() if not strip_view.empty else {}

    front  = active.iloc[0]
    hiking = float(front["implied_rate"]) >= ocr
    best   = front

    for _, row in active.iloc[1:].iterrows():
        if hiking and float(row["implied_rate"]) >= float(best["implied_rate"]):
            best = row
        elif not hiking and float(row["implied_rate"]) <= float(best["implied_rate"]):
            best = row
        else:
            break

    result = best.to_dict()
    # Convert date objects to isoformat strings for JSON serialisation
    if hasattr(result.get("expiry"), "isoformat"):
        result["expiry"] = result["expiry"].isoformat()
    return result


# ── A4: Meeting-path maths & probability distributions ───────────────────────

def post_meeting_rate(
    contract_rate: float,
    prev_rate: float,
    meeting_day: int,
    days_in_month: int,
) -> float:
    """
    Recover the implied post-meeting rate from a ZQ contract settle.

    monthly_avg = ((D-1) · prevRate + (N-D+1) · postRate) / N
    Solved for postRate:
      postRate = (monthly_avg · N - (D-1) · prevRate) / (N - D + 1)
    """
    days_after = days_in_month - meeting_day + 1
    if days_after <= 0:
        return contract_rate
    return (contract_rate * days_in_month - (meeting_day - 1) * prev_rate) / days_after


def meeting_probs(post_rate: float, effr: float) -> dict[str, float]:
    """
    CME FedWatch-style probability mass.
    Interpolates between the two nearest 25 bp policy increments.
    """
    raw   = (effr - post_rate) / 0.25
    lower = int(math.floor(raw))
    frac  = raw - lower
    mass: dict[int, float] = {lower: 1.0 - frac}
    if frac > 0.001:
        mass[lower + 1] = frac
    return {
        "hold":   100.0 * mass.get(0,  0.0),
        "cut25":  100.0 * mass.get(1,  0.0),
        "cut50":  100.0 * mass.get(2,  0.0),
        "cut75":  100.0 * mass.get(3,  0.0),
        "hike25": 100.0 * mass.get(-1, 0.0),
    }


def build_meeting_path(
    zq_strip: pd.DataFrame,
    effr_today: float,
    fomc_dates: list[date],
) -> list[dict]:
    """
    Iterate the FOMC calendar, chaining the post-meeting rate forward.
    Returns a list of dicts with meeting date, post_rate, cum_cuts, and
    FedWatch-style probability columns.
    """
    # Build (year, month) → implied_rate lookup
    zq_by_month: dict[tuple[int, int], float] = {
        (int(r["expiry"].year), int(r["expiry"].month)): float(r["implied_rate"])
        for _, r in zq_strip.iterrows()
    }
    fomc_keys = {(d.year, d.month) for d in fomc_dates}

    prev = effr_today
    rows: list[dict] = []

    for d in fomc_dates:
        rate = zq_by_month.get((d.year, d.month))
        if rate is None:
            continue

        N  = monthrange(d.year, d.month)[1]
        ny = d.year + (1 if d.month == 12 else 0)
        nm = d.month % 12 + 1
        next_rate        = zq_by_month.get((ny, nm))
        next_has_meeting = (ny, nm) in fomc_keys

        # Edge-case shortcut from playbook slide 8
        if next_rate is not None and not next_has_meeting:
            post = next_rate
        else:
            post = post_meeting_rate(rate, prev, d.day, N)

        probs = meeting_probs(post, effr_today)
        rows.append({
            "meeting":  d.isoformat(),
            "post_rate": round(post, 4),
            "cum_cuts":  round((effr_today - post) / 0.25, 2),
            "hold":   round(probs["hold"],   1),
            "cut25":  round(probs["cut25"],  1),
            "cut50":  round(probs["cut50"],  1),
            "cut75":  round(probs["cut75"],  1),
            "hike25": round(probs["hike25"], 1),
        })
        prev = post

    return rows


# ── A5: Spread matrix & CB LVL ────────────────────────────────────────────────

def spread_matrix(
    strip_view: pd.DataFrame,
    horizons_m: tuple[int, ...] = (3, 6, 9, 12),
) -> list[dict]:
    """
    Forward calendar-spread matrix — basis-point difference from each
    contract to its +3M / +6M / +9M / +12M neighbour.
    """
    if strip_view.empty:
        return []

    rows: list[dict] = []
    for _, row in strip_view.iterrows():
        row_mo = int(row["expiry"].month) + 12 * int(row["expiry"].year)
        spreads: dict[str, int | None] = {}
        for h in horizons_m:
            target  = row_mo + h
            forward = strip_view[strip_view["expiry"].apply(
                lambda d: int(d.month) + 12 * int(d.year) >= target
            )]
            if not forward.empty:
                spreads[f"+{h}M"] = round(
                    (float(forward.iloc[0]["implied_rate"]) - float(row["implied_rate"])) * 100
                )
            else:
                spreads[f"+{h}M"] = None
        rows.append({"contract": str(row["symbol"]), **spreads})

    return rows


def cb_levels(effr: float, band_bp: int = 150, step_bp: int = 25) -> list[float]:
    """
    Return a grid of 25 bp policy-rate levels centred on the current EFFR.
    The 'settlement' level (EFFR rounded to nearest 25 bp) is included.
    """
    settle = round(effr / 0.25) * 0.25
    n      = band_bp // step_bp
    return [
        round(settle + (i - n) * (step_bp / 100.0), 4)
        for i in range(2 * n + 1)
    ]
