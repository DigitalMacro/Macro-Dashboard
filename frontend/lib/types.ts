// Shared TypeScript interfaces for the MFERM dashboard

export interface AssetInfo {
  ticker: string;
  name: string;
  sector: string;
  assetClass: "equity" | "etf" | "index";
  currentPrice: number;
  currency: string;
}

// Common fields on every response that goes through fit_plsr — describes
// which factors actually backed this fit and how much history it used.
export interface ModelFitMeta {
  factorsUsed: string[];
  factorsMissing: string[];
  nFactors: number;
  nObs: number | null;
  firstDate: string | null;
}

export interface FactorExposures extends ModelFitMeta {
  ticker: string;
  date: string;
  exposures: Record<string, number>; // factor_name → beta
  rsquared: number;
  windowDays: number;
  asOf: string | null;
  source: string | null;
}

export interface Attribution extends ModelFitMeta {
  dates: string[];
  actualReturn: number[];
  factorReturn: number[];
  specificReturn: number[];
  factorBreakdown: Record<string, number[]>; // factor_name → daily contribs
  summary: {
    totalReturn: number;
    factorReturn: number;
    specificReturn: number;
    rsquared: number;
    nObs: number;
  };
  asOf: string | null;
  source: string | null;
}

export interface RiskAttribution extends ModelFitMeta {
  factorVol: number;      // annualised %
  specificVol: number;    // annualised %
  totalVol: number;       // annualised %
  factorShare: number;    // 0–1
  mctr: Record<string, number>; // factor → marginal contrib to risk
  rsquared?: number;
  ticker?: string;
  asOf: string | null;
  source: string | null;
}

export interface RollingRisk extends ModelFitMeta {
  dates: string[];
  factorVol: number[];
  specificVol: number[];
  asOf: string | null;
  source: string | null;
}

export interface StressResult extends ModelFitMeta {
  scenario: string;
  ticker?: string;
  label?: string;
  factorImpacts: Record<string, number>; // factor → % impact
  totalImpact: number;
  peripheralMoves?: Record<string, number>; // correlated scenario only
  nDays?: number;
  asOf: string | null;
  source: string | null;
}

export interface FactorLevel {
  date: string;
  value: number;
  unit: string;
  source: string;
  fidelity: "perfect" | "high" | "medium";
}

export interface ApiError {
  error: string;
  code: "INVALID_TICKER" | "INSUFFICIENT_DATA" | "API_ERROR" | "INVALID_FACTOR" | "INVALID_SCENARIO";
  detail: string;
}

export type DateRange = "1M" | "3M" | "6M" | "YTD" | "1Y" | "custom";

export interface HeatmapRow {
  ticker: string;
  name: string;
  exposures: Record<string, number>;
}

// ── STIR module ───────────────────────────────────────────────────────────────

export interface StirContract {
  symbol: string;
  expiry: string;
  settle: number;
  impliedRate: number;
  vsOcrBp: number;
}

export interface StirMeetingPoint {
  meeting: string;
  postRate: number;
  cumCuts: number;
  hold: number;
  cut25: number;
  cut50: number;
  cut75: number;
  hike25: number;
}

export interface StirSpreadRow {
  contract: string;
  "+3M":  number | null;
  "+6M":  number | null;
  "+9M":  number | null;
  "+12M": number | null;
}

export interface StirSnapshot {
  asOf: string;
  effr: number;
  sofr: number;
  sofrBasisBp: number;
  referenceRateSource: "FRED" | "fallback";
  dataSource: string;
  fomcDates: string[];
  sr3Strip: StirContract[];
  zqStrip: StirContract[];
  sofrTerminalSymbol: string | null;
  ffTerminalSymbol: string | null;
  meetingPath: StirMeetingPoint[];
  spreadMatrix: StirSpreadRow[];
  cbLevels: number[];
}
