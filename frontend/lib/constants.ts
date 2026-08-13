// MFERM factor metadata — authoritative definitions

export const FACTOR_LABELS: Record<string, string> = {
  economic_growth:         "Economic growth",
  metals:                  "Metals",
  energy:                  "Energy",
  fwd_growth_expectations: "Forward growth expectations",
  inflation:               "Inflation",
  ig_credit_spread:        "IG Credit Spread (Baa–10Y)",
  "10y_yield":             "10Y yield",
  real_rates:              "Real rates",
  cb_rate_expectations:    "CB rate expectations",
  dm_fx:                   "DM FX",
  cb_qt_expectations:      "CB QT expectations",
  risk_aversion:           "Risk aversion",
  market:                  "Market",
};

export const FACTOR_BUCKETS: Record<string, string[]> = {
  "Growth expectations": [
    "economic_growth", "metals", "energy",
    "fwd_growth_expectations", "inflation",
  ],
  "Financial conditions": [
    "ig_credit_spread", "10y_yield", "real_rates",
    "cb_rate_expectations", "dm_fx", "cb_qt_expectations",
  ],
  "Risk appetite": ["risk_aversion"],
};

export const FACTOR_UNITS: Record<string, string> = {
  economic_growth:         "% (CFNAI)",
  metals:                  "% return",
  energy:                  "% return",
  fwd_growth_expectations: "bp (5s30s)",
  inflation:               "bp (breakeven)",
  ig_credit_spread:        "bp (Baa−10Y)",
  "10y_yield":             "bp",
  real_rates:              "bp",
  cb_rate_expectations:    "bp (fwd spread)",
  dm_fx:                   "% return (TWI)",
  cb_qt_expectations:      "pts (MOVE)",
  risk_aversion:           "pts (VIX)",
  market:                  "% return",
};

export const PROXY_FIDELITY: Record<string, "perfect" | "high" | "medium"> = {
  economic_growth:         "medium",
  metals:                  "high",
  energy:                  "high",
  fwd_growth_expectations: "medium",
  inflation:               "high",
  // Downgraded from "high" (was rated for BAMLH0A0HYM2, ICE BofA HY OAS).
  // BAA10Y correlates 0.63 with what this factor previously measured and is
  // investment-grade rather than high-yield — materially lower tail
  // sensitivity, not a like-for-like swap. See factor_fetcher.py F6 comment.
  ig_credit_spread:        "medium",
  "10y_yield":             "perfect",
  real_rates:              "perfect",
  cb_rate_expectations:    "medium",
  dm_fx:                   "high",
  cb_qt_expectations:      "medium",
  risk_aversion:           "perfect",
};

export const PROXY_SOURCE: Record<string, string> = {
  economic_growth:         "FRED: CFNAI (monthly, interpolated)",
  metals:                  "Yahoo Finance: HG=F",
  energy:                  "Yahoo Finance: CL=F",
  fwd_growth_expectations: "FRED: DGS30 − DGS5",
  inflation:               "FRED: T5YIE",
  ig_credit_spread:        "FRED: BAA10Y",
  "10y_yield":             "FRED: DGS10",
  real_rates:              "FRED: DFII10",
  cb_rate_expectations:    "FRED: THREEFF1 − DGS1",
  dm_fx:                   "FRED: DTWEXBGS",
  cb_qt_expectations:      "Yahoo Finance: ^MOVE",
  risk_aversion:           "Yahoo Finance: ^VIX",
};

// Bucket colour palette
export const BUCKET_COLOURS: Record<string, string> = {
  "Growth expectations":  "#3b82f6", // blue
  "Financial conditions": "#f59e0b", // amber
  "Risk appetite":        "#ef4444", // red
};

// Per-factor colours (hue within bucket)
export const FACTOR_COLOURS: Record<string, string> = {
  economic_growth:         "#60a5fa",
  metals:                  "#3b82f6",
  energy:                  "#1d4ed8",
  fwd_growth_expectations: "#93c5fd",
  inflation:               "#bfdbfe",
  ig_credit_spread:        "#f59e0b",
  "10y_yield":             "#d97706",
  real_rates:              "#b45309",
  cb_rate_expectations:    "#fbbf24",
  dm_fx:                   "#fde68a",
  cb_qt_expectations:      "#fef3c7",
  risk_aversion:           "#ef4444",
  market:                  "#6b7280",
};

// Stress scenario presets
export const STRESS_SCENARIOS = [
  { id: "trade_war_2018", label: "US-China Trade War (Oct–Dec 2018)" },
  { id: "covid_2020",     label: "COVID Crash (Feb–Mar 2020)" },
  { id: "rates_2022",     label: "Rate Shock 2022 (Jan–Oct 2022)" },
  { id: "gfc_2008",       label: "Global Financial Crisis (Sep–Dec 2008)" },
];

// Quick-select preset tickers
export const PRESET_TICKERS = [
  "SPY", "QQQ", "XLF", "XLE", "GLD", "TLT", "HYG", "AAPL", "NVDA", "JPM",
];

// Shock ranges for uncorrelated stress sliders (in std dev units)
export const SHOCK_RANGES: Record<string, { min: number; max: number; step: number; label: string }> = {
  ig_credit_spread:        { min: -4, max: 4, step: 0.1, label: "std devs" },
  inflation:               { min: -4, max: 4, step: 0.1, label: "std devs" },
  economic_growth:         { min: -4, max: 4, step: 0.1, label: "std devs" },
  risk_aversion:           { min: -4, max: 4, step: 0.1, label: "std devs" },
  "10y_yield":             { min: -4, max: 4, step: 0.1, label: "std devs" },
  dm_fx:                   { min: -4, max: 4, step: 0.1, label: "std devs" },
  real_rates:              { min: -4, max: 4, step: 0.1, label: "std devs" },
  energy:                  { min: -4, max: 4, step: 0.1, label: "std devs" },
  metals:                  { min: -4, max: 4, step: 0.1, label: "std devs" },
  fwd_growth_expectations: { min: -4, max: 4, step: 0.1, label: "std devs" },
  cb_rate_expectations:    { min: -4, max: 4, step: 0.1, label: "std devs" },
  cb_qt_expectations:      { min: -4, max: 4, step: 0.1, label: "std devs" },
};

// Heatmap colour thresholds (exposure to 1 std dev factor move)
export const HEATMAP_THRESHOLDS = [
  { min: 0.5,  colour: "#15803d", label: "Strong positive" },
  { min: 0.15, colour: "#86efac", label: "Positive" },
  { min: -0.15,colour: "#f3f4f6", label: "Neutral" },
  { min: -0.5, colour: "#fca5a5", label: "Negative" },
  { min: -Infinity, colour: "#dc2626", label: "Strong negative" },
];
