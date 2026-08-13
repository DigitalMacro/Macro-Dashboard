// Typed fetch wrappers for all MFERM API endpoints

import type {
  AssetInfo,
  FactorExposures,
  Attribution,
  RiskAttribution,
  RollingRisk,
  StressResult,
  ModelFitMeta,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL;

// Every fit_plsr-backed response carries these five fields (snake_case on
// the wire). Shared mapper so each endpoint doesn't repeat it.
interface RawModelFitMeta {
  factors_used: string[];
  factors_missing: string[];
  n_factors: number;
  n_obs: number | null;
  first_date: string | null;
}

function mapModelFitMeta(d: RawModelFitMeta): ModelFitMeta {
  return {
    factorsUsed:    d.factors_used,
    factorsMissing: d.factors_missing,
    nFactors:       d.n_factors,
    nObs:           d.n_obs,
    firstDate:      d.first_date,
  };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err?.detail?.error ?? err?.error ?? res.statusText), {
      code: err?.detail?.code ?? "API_ERROR",
      status: res.status,
    });
  }
  return res.json();
}

// ── Asset ────────────────────────────────────────────────────────────────────

export async function validateTicker(ticker: string): Promise<AssetInfo> {
  return apiFetch<AssetInfo>(`/api/asset/validate/${encodeURIComponent(ticker)}`);
}

// ── PLSR model ────────────────────────────────────────────────────────────────

export async function getExposures(ticker: string): Promise<FactorExposures> {
  const data = await apiFetch<{
    ticker: string; date: string;
    exposures: Record<string, number>; rsquared: number; windowDays: number;
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>(`/api/model/${encodeURIComponent(ticker)}/exposures`);
  return {
    ticker:     data.ticker,
    date:       data.date,
    exposures:  data.exposures,
    rsquared:   data.rsquared,
    windowDays: data.windowDays,
    asOf:       data.as_of,
    source:     data.source,
    ...mapModelFitMeta(data),
  };
}

export async function getAttribution(
  ticker: string,
  start: string,
  end: string,
): Promise<Attribution> {
  const data = await apiFetch<{
    dates: string[];
    actual_return: number[];
    factor_return: number[];
    specific_return: number[];
    factor_breakdown: Record<string, number[]>;
    summary: { total_return: number; factor_return: number; specific_return: number; rsquared: number; n_obs: number };
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>(`/api/model/${encodeURIComponent(ticker)}/attribution?start=${start}&end=${end}`);
  return {
    dates:           data.dates,
    actualReturn:    data.actual_return,
    factorReturn:    data.factor_return,
    specificReturn:  data.specific_return,
    factorBreakdown: data.factor_breakdown,
    summary: {
      totalReturn:    data.summary.total_return,
      factorReturn:   data.summary.factor_return,
      specificReturn: data.summary.specific_return,
      rsquared:       data.summary.rsquared,
      nObs:           data.summary.n_obs,
    },
    asOf:   data.as_of,
    source: data.source,
    ...mapModelFitMeta(data),
  };
}

export async function getRisk(ticker: string): Promise<RiskAttribution> {
  const data = await apiFetch<{
    factor_vol: number; specific_vol: number; total_vol: number;
    factor_share: number; mctr: Record<string, number>; rsquared: number; ticker: string;
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>(`/api/model/${encodeURIComponent(ticker)}/risk`);
  return {
    factorVol:   data.factor_vol,
    specificVol: data.specific_vol,
    totalVol:    data.total_vol,
    factorShare: data.factor_share,
    mctr:        data.mctr,
    rsquared:    data.rsquared,
    ticker:      data.ticker,
    asOf:        data.as_of,
    source:      data.source,
    ...mapModelFitMeta(data),
  };
}

export async function getRollingRisk(ticker: string, rollWindow = 30): Promise<RollingRisk> {
  const data = await apiFetch<{
    dates: string[]; factor_vol: number[]; specific_vol: number[];
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>(`/api/model/${encodeURIComponent(ticker)}/rolling-risk?roll_window=${rollWindow}`);
  return {
    dates:       data.dates,
    factorVol:   data.factor_vol,
    specificVol: data.specific_vol,
    asOf:        data.as_of,
    source:      data.source,
    ...mapModelFitMeta(data),
  };
}

// ── Stress testing ────────────────────────────────────────────────────────────

export async function stressHistorical(ticker: string, scenario: string): Promise<StressResult> {
  const data = await apiFetch<{
    scenario: string; label: string; n_days: number;
    factor_impacts: Record<string, number>; total_impact: number;
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>("/api/stress/historical", {
    method: "POST",
    body: JSON.stringify({ ticker, scenario }),
  });
  return {
    scenario:      data.scenario,
    label:         data.label,
    nDays:         data.n_days,
    factorImpacts: data.factor_impacts,
    totalImpact:   data.total_impact,
    asOf:          data.as_of,
    source:        data.source,
    ...mapModelFitMeta(data),
  };
}

export async function stressUncorrelated(
  ticker: string,
  shocks: Record<string, number>,
): Promise<StressResult> {
  const data = await apiFetch<{
    scenario: string; factor_impacts: Record<string, number>; total_impact: number;
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>("/api/stress/uncorrelated", {
    method: "POST",
    body: JSON.stringify({ ticker, shocks }),
  });
  return {
    scenario:      data.scenario,
    factorImpacts: data.factor_impacts,
    totalImpact:   data.total_impact,
    asOf:          data.as_of,
    source:        data.source,
    ...mapModelFitMeta(data),
  };
}

export async function stressCorrelated(
  ticker: string,
  coreFactor: string,
  shockValue: number,
): Promise<StressResult> {
  const data = await apiFetch<{
    scenario: string; total_impact: number;
    factor_impacts: Record<string, number>;
    peripheral_moves: Record<string, number>;
    as_of: string | null; source: string | null;
  } & RawModelFitMeta>("/api/stress/correlated", {
    method: "POST",
    body: JSON.stringify({ ticker, core_factor: coreFactor, shock_value: shockValue }),
  });
  return {
    scenario:        data.scenario,
    factorImpacts:   data.factor_impacts,
    totalImpact:     data.total_impact,
    peripheralMoves: data.peripheral_moves,
    asOf:            data.as_of,
    source:          data.source,
    ...mapModelFitMeta(data),
  };
}
