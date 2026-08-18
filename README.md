# Macro-Factor Equity Risk Model

A factor model that decomposes equity returns into macro drivers, and a dashboard for reading the result.

Live: https://macro-dashboard-gamma-ten.vercel.app

## What it does

Answers the question: what macro conditions is this position actually a bet on?

The model regresses asset returns against twelve macro factors using partial least squares, producing exposures that answer how much of a drawdown was macro vs. idiosyncratic.

| Module | What it answers |
|---|---|
| Return Attribution | Which factors drove realised returns over a window |
| Risk Attribution | How variance decomposes across factors, and how that shifts over time |
| Stress Testing | Historical replays (2008, 2018, 2020, 2022) and custom factor shocks |
| Exposure Heatmap | Cross-sectional factor loadings across a ticker set |
| Regime Matrix | Growth/inflation regime classification with asset performance by regime |
| Cross-Asset | Correlation structure and risk-appetite signals |
| Yield Curve · Rate Decomposition · Global Rates · FX | Supporting macro context, including direct ECB, Bank of England and MoF integrations |
| Portfolio | Paper-trading book with daily mark-to-market |

## The model

Partial least squares regression, 3 latent components, 250-day rolling estimation window.

PLSR rather than OLS because the twelve macro factors are substantially collinear — real rates, nominal yields and inflation breakevens move together by construction. OLS coefficients on collinear regressors are unstable and flip signs on small sample changes. PLSR projects onto orthogonal latent components that maximise covariance with the response, trading a little interpretability for materially more stable loadings.

**Why three components.** The count was validated out-of-sample rather than chosen by rule of thumb. Fitting components from 1 to 8 under true one-step-ahead walk-forward (fit on 250 days, predict the next day, roll forward, 5,503 out-of-sample predictions per configuration) the marginal return collapses after the third component. On SPY, the first three components buy 14.4 percentage points of out-of-sample R² (0.497 → 0.642); the next five buy 0.5pp combined. TLT and XLE show the same elbow. XLE is the clearest case: out-of-sample R² peaks at four components and then declines through eight, while in-sample R² keeps climbing — the textbook overfitting signature. Three components capture 99.2%, 97.5% and 99.6% of each ticker's best achievable out-of-sample fit respectively, at a fraction of the complexity.

Every factor is normalised as a 250-day rolling z-score of first differences, so exposures are comparable across factors with different units and scales.

## The twelve factors

| Factor | Series | Source | Transform |
|---|---|---|---|
| 10y_yield | DGS10 | FRED | diff |
| real_rates | DFII10 (10Y TIPS) | FRED | diff |
| Inflation expectations | T5YIE (5Y breakeven) | FRED | diff |
| cb_rate_expectations | THREEFF1 − DGS1 | FRED | spread, diff |
| fwd_growth_expectations | DGS30 − DGS5 | FRED | spread, diff |
| economic_growth | CFNAI | FRED | resampled to business days, forward-filled, diff |
| ig_credit_spread | BAA10Y (Baa − 10Y Treasury) | FRED | diff |
| risk_aversion | VIXCLS, fallback ^VIX | FRED / Yahoo | diff |
| dm_fx | DX-Y.NYB (DXY) | Yahoo | pct-change |
| rate_vol | ^MOVE | Yahoo | diff |
| energy | CL=F (WTI front-month), fallback DCOILWTICO | Yahoo / FRED | pct-change |
| metals | HG=F (copper front-month) | Yahoo | pct-change |

Plus a market factor (^GSPC) for the systematic equity component.

Two factors have primary/fallback source pairs rather than a single series, so which source backed a given day's value is runtime-dependent.

The credit and volatility factors follow the Chen, Roll & Ross (1986) tradition — a default spread and a risk-appetite proxy as the canonical macro risk premia.

## Honest limitations

What a reader should know before taking any number here seriously.

**Effective history starts in 2003, not 1990.** The configured start date is 1990-01-01, but the fully-joined factor matrix is bound by the TIPS-derived series — inflation expectations (T5YIE) and real rates (DFII10) — which begin 2003-01-02 because the US Treasury TIPS market wasn't deep enough to support 5Y breakevens and 10Y real yields before then. Extending earlier would require replacing both TIPS-derived factors, and there is no clean substitute the way DXY substituted for the dollar index.

**The credit factor is investment grade, not high yield.** It was originally built on ICE BofA high-yield OAS, but that series truncates to 2023-08-14 through the FRED API, while FRED's own web charts show full history. Rather than accept a 2.7-year model, the factor was rebuilt on Moody's BAA10Y. The two correlate 0.63 over the overlapping window: related, not equivalent. BAA10Y is materially less sensitive in genuine credit stress. Read credit exposures as investment-grade risk appetite, not junk.

**The FX factor is concentrated.** DM_FX uses DXY, which is roughly 58% EUR on currency weights fixed since 1973 and never rebalanced. It behaves substantially as an inverted EUR/USD series. It replaced the Fed's Broad dollar index (DTWEXBGS), which was better diversified but included EM and which capped history at 2006. The two correlate 0.73. The Fed's Major Currencies index (DTWEXM) would have been the better-designed factor, but it was discontinued in 2019.

**Factor dropout is surfaced, not hidden.** When a factor is missing or has a gap in the estimation window, the model does not silently proceed. PLSR redistributes the missing factor's explained variance across the survivors, so every exposure in that fit is affected, not just the absent one. Results carry `factors_used`, `factors_missing` and `n_factors`; the UI shows a banner naming what's missing; and missing factors render visually distinct from a measured zero rather than as 0.0. The 2008 stress scenario returns −34.1% on 12 factors and −27.6% on 11 — the disclosure is not cosmetic.

**Every displayed source and timestamp is observed, not assumed.** Each endpoint returns the actual last observation date of its underlying series and the actual sources fetched. Where freshness or provenance can't be determined, the UI renders nothing rather than a plausible guess.

**Short-term interest rate module excluded from this build.** The STIR module — Fed Funds and SOFR futures, implied policy path, meeting-by-meeting pricing — is built and works, but depends on CME futures data. Redistributing that publicly requires licensing that isn't in place, so it's gated out of the public deployment.

**The portfolio module is paper trading.** Positions are entered manually and marked daily. No broker integration, no live execution.

**This is a research project, not investment advice.** Nothing here is a recommendation, and the model has not been validated against live capital.

## Current read

Macro explainability has faded into the background as equities continue their AI-driven march higher. The curve continues pricing a policy error, with the Fed on hold while inflation stays elevated in level terms even as the regime classifier reads decelerating on both growth and inflation. Real rates remain the largest single factor negative exposure for SPY. Continued bond selloff that pushes stock-bond correlation positive removes the hedge and can create correlations across factors (i.e. rate vol, forward growth expectations).

As of 8/17/26.

## Stack

**Backend** — FastAPI, pandas, scikit-learn. FRED via fredapi, market data via yfinance, plus direct ECB, Bank of England and MoF endpoints for non-US rates. In-memory TTL cache.

**Frontend** — Next.js 14 (App Router), TypeScript, Tailwind, Recharts.

**Deployment** — frontend on Vercel, backend containerised on Railway.

## Running locally

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env        # add your FRED API key
uvicorn main:app --reload

# Frontend
cd frontend
npm install
cp ../.env.example .env.local
npm run dev
```

A free FRED API key is required: https://fred.stlouisfed.org/docs/api/api_key.html

Or with Docker:

```bash
docker-compose up --build
```

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `FRED_API_KEY` | Backend | Required |
| `ALLOWED_ORIGINS` | Backend | Comma-separated CORS origins |
| `DATA_START` | Backend | Defaults to 1990-01-01 |
| `NEXT_PUBLIC_API_URL` | Frontend | Backend URL, no trailing slash |
| `NEXT_PUBLIC_ENABLE_STIR` | Both | Must be explicitly `false` in production, not omitted |

## Tests

```bash
cd backend && pytest        # 37 tests
```

## Roadmap

- Replace ^MOVE for `rate_vol` — Yahoo's history for it developed a 17-business-day hole in July 2026, confirmed absent across four fetch methods. FRED doesn't carry a MOVE series, so the replacement isn't obvious.
- Pre-2003 history requires replacing the TIPS-derived `inflation` and `real_rates` factors. No candidate identified; this is the blocker on any dot-com-era stress scenario.
- STIR module in the public build, pending data licensing

---

Built by Ryan Duffy — ryanjduffy3@gmail.com
