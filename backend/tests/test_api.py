"""
Phase 3 tests — FastAPI endpoint tests using TestClient.
Run with: pytest tests/test_api.py -v
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_validate_spy():
    r = client.get("/api/asset/validate/SPY")
    assert r.status_code == 200
    data = r.json()
    assert data["valid"] is True
    assert data["ticker"] == "SPY"
    assert data["currentPrice"] > 0


def test_validate_invalid_ticker():
    r = client.get("/api/asset/validate/XXXXBADTICKER9999")
    assert r.status_code == 404


def test_exposures_spy():
    r = client.get("/api/model/SPY/exposures")
    assert r.status_code == 200
    data = r.json()
    assert "exposures" in data
    assert "rsquared" in data
    assert data["rsquared"] > 0
    assert "risk_aversion" in data["exposures"]
    assert data["exposures"]["risk_aversion"] < 0  # SPY negative to VIX


def test_attribution_spy():
    r = client.get("/api/model/SPY/attribution?start=2024-01-01&end=2024-06-30")
    assert r.status_code == 200
    data = r.json()
    assert "dates" in data
    assert "actual_return" in data
    assert "factor_breakdown" in data
    assert len(data["dates"]) > 0
    assert len(data["actual_return"]) == len(data["dates"])


def test_risk_spy():
    r = client.get("/api/model/SPY/risk")
    assert r.status_code == 200
    data = r.json()
    assert "factor_vol" in data
    assert "specific_vol" in data
    assert "total_vol" in data
    assert "factor_share" in data
    assert "mctr" in data
    assert 0 <= data["factor_share"] <= 1


def test_rolling_risk_spy():
    r = client.get("/api/model/SPY/rolling-risk")
    assert r.status_code == 200
    data = r.json()
    assert "dates" in data
    assert "factor_vol" in data
    assert "specific_vol" in data


def test_stress_historical_covid():
    r = client.post("/api/stress/historical",
                    json={"ticker": "SPY", "scenario": "covid_2020"})
    assert r.status_code == 200
    data = r.json()
    assert "total_impact" in data
    assert data["total_impact"] < 0


def test_stress_historical_invalid_scenario():
    r = client.post("/api/stress/historical",
                    json={"ticker": "SPY", "scenario": "INVALID_SCENARIO"})
    assert r.status_code == 422


def test_stress_uncorrelated():
    r = client.post("/api/stress/uncorrelated",
                    json={"ticker": "SPY",
                          "shocks": {"risk_aversion": 2.0, "ig_credit_spread": 1.5}})
    assert r.status_code == 200
    data = r.json()
    assert "total_impact" in data
    assert data["total_impact"] < 0  # VIX shock hurts SPY


def test_stress_correlated():
    r = client.post("/api/stress/correlated",
                    json={"ticker": "SPY",
                          "core_factor": "risk_aversion",
                          "shock_value": 2.0})
    assert r.status_code == 200
    data = r.json()
    assert "total_impact" in data
    assert "peripheral_moves" in data
