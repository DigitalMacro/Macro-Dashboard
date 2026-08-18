"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WaterfallChart } from "@/components/charts/WaterfallChart";
import { DegradedModelBanner } from "@/components/dashboard/DegradedModelBanner";
import { stressHistorical, stressUncorrelated, stressCorrelated, getExposures } from "@/lib/api";
import type { StressResult } from "@/lib/types";
import { STRESS_SCENARIOS, SHOCK_RANGES, FACTOR_LABELS } from "@/lib/constants";
import { Loader2 } from "lucide-react";

const FACTOR_COLS = [
  "economic_growth", "metals", "energy", "fwd_growth_expectations",
  "inflation", "ig_credit_spread", "10y_yield", "real_rates",
  "cb_rate_expectations", "dm_fx", "rate_vol", "risk_aversion",
];

type Freshness = { asOf: string | null; source: string | null };
type FitMeta = { factorsMissing: string[]; nFactors: number; nObs: number | null; firstDate: string | null };

interface StressTestingProps {
  ticker: string;
  onFreshness?: (freshness: Freshness) => void;
}

// ── Historical sub-tab ────────────────────────────────────────────────────────

function HistoricalTab({ ticker, onFreshness }: { ticker: string; onFreshness?: (freshness: Freshness) => void }) {
  const [scenario, setScenario] = useState("covid_2020");
  const [result,   setResult]   = useState<StressResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await stressHistorical(ticker, scenario);
      setResult(r);
      onFreshness?.({ asOf: r.asOf, source: r.source });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Stress test failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Scenario</label>
          <Select value={scenario} onValueChange={setScenario}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRESS_SCENARIOS.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={run} disabled={loading} className="shrink-0">
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Run
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Total impact:</span>
            <Badge variant={result.totalImpact >= 0 ? "success" : "destructive"} className="text-sm px-3 py-1">
              {result.totalImpact >= 0 ? "+" : ""}{result.totalImpact.toFixed(2)}%
            </Badge>
            {result.nDays && (
              <span className="text-xs text-muted-foreground">over {result.nDays} trading days</span>
            )}
          </div>
          <WaterfallChart factorImpacts={result.factorImpacts} totalImpact={result.totalImpact} />
        </div>
      )}
    </div>
  );
}

// ── Uncorrelated sub-tab ──────────────────────────────────────────────────────

function UncorrelatedTab({
  ticker, onFreshness, factorsMissing,
}: {
  ticker: string;
  onFreshness?: (freshness: Freshness) => void;
  factorsMissing: string[];
}) {
  const initialShocks: Record<string, number> = {};
  FACTOR_COLS.forEach((f) => (initialShocks[f] = 0));

  const [shocks,  setShocks]  = useState<Record<string, number>>(initialShocks);
  const [result,  setResult]  = useState<StressResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  function updateShock(factor: string, val: number) {
    setShocks((prev) => ({ ...prev, [factor]: val }));
  }

  async function run() {
    const activeShocks: Record<string, number> = {};
    for (const [f, v] of Object.entries(shocks)) {
      if (v !== 0 && !factorsMissing.includes(f)) activeShocks[f] = v;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await stressUncorrelated(ticker, activeShocks);
      setResult(r);
      onFreshness?.({ asOf: r.asOf, source: r.source });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Stress test failed");
    } finally {
      setLoading(false);
    }
  }

  function resetAll() {
    const r: Record<string, number> = {};
    FACTOR_COLS.forEach((f) => (r[f] = 0));
    setShocks(r);
    setResult(null);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {FACTOR_COLS.map((factor) => {
          const range = SHOCK_RANGES[factor] ?? { min: -4, max: 4, step: 0.1, label: "std devs" };
          const val   = shocks[factor] ?? 0;
          const isMissing = factorsMissing.includes(factor);
          return (
            <div key={factor} className={`space-y-1 ${isMissing ? "opacity-50" : ""}`}>
              <div className="flex justify-between text-xs">
                <span className="font-medium">{FACTOR_LABELS[factor] ?? factor}</span>
                {isMissing ? (
                  <span className="text-amber-600">Unavailable — not in current model fit</span>
                ) : (
                  <span className={val !== 0 ? (val > 0 ? "text-green-700" : "text-red-700") : "text-muted-foreground"}>
                    {val >= 0 ? "+" : ""}{val.toFixed(1)} {range.label}
                  </span>
                )}
              </div>
              <Slider
                min={range.min}
                max={range.max}
                step={range.step}
                value={[isMissing ? 0 : val]}
                onValueChange={([v]) => updateShock(factor, v)}
                disabled={isMissing}
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <Button onClick={run} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Calculate impact
        </Button>
        <Button variant="outline" onClick={resetAll}>Reset</Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Total impact:</span>
            <Badge variant={result.totalImpact >= 0 ? "success" : "destructive"} className="text-sm px-3 py-1">
              {result.totalImpact >= 0 ? "+" : ""}{result.totalImpact.toFixed(2)}%
            </Badge>
          </div>
          <WaterfallChart factorImpacts={result.factorImpacts} totalImpact={result.totalImpact} />
        </div>
      )}
    </div>
  );
}

// ── Correlated sub-tab ────────────────────────────────────────────────────────

function CorrelatedTab({ ticker, onFreshness }: { ticker: string; onFreshness?: (freshness: Freshness) => void }) {
  const [coreFactor,  setCoreFactor]  = useState("risk_aversion");
  const [shockValue,  setShockValue]  = useState(0);
  const [result,      setResult]      = useState<StressResult | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await stressCorrelated(ticker, coreFactor, shockValue);
      setResult(r);
      onFreshness?.({ asOf: r.asOf, source: r.source });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Stress test failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Core factor</label>
          <Select value={coreFactor} onValueChange={setCoreFactor}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FACTOR_COLS.map((f) => (
                <SelectItem key={f} value={f}>{FACTOR_LABELS[f] ?? f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="font-medium">Shock size</span>
            <span className={shockValue !== 0 ? (shockValue > 0 ? "text-green-700" : "text-red-700") : "text-muted-foreground"}>
              {shockValue >= 0 ? "+" : ""}{shockValue.toFixed(1)} std devs
            </span>
          </div>
          <Slider
            min={-4} max={4} step={0.1}
            value={[shockValue]}
            onValueChange={([v]) => setShockValue(v)}
          />
        </div>
      </div>

      <Button onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        Run correlated shock
      </Button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Total impact:</span>
            <Badge variant={result.totalImpact >= 0 ? "success" : "destructive"} className="text-sm px-3 py-1">
              {result.totalImpact >= 0 ? "+" : ""}{result.totalImpact.toFixed(2)}%
            </Badge>
          </div>
          {result.peripheralMoves && Object.keys(result.peripheralMoves).length > 0 && (
            <Card className="bg-muted/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Estimated peripheral factor moves (conditional expectation)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  {Object.entries(result.peripheralMoves)
                    .filter(([, v]) => Math.abs(v) > 0.01)
                    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
                    .map(([f, v]) => (
                      <div key={f} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{FACTOR_LABELS[f] ?? f}</span>
                        <span className={v >= 0 ? "text-green-700 tabular-nums" : "text-red-700 tabular-nums"}>
                          {v >= 0 ? "+" : ""}{v.toFixed(2)}σ
                        </span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
          <WaterfallChart factorImpacts={result.factorImpacts} totalImpact={result.totalImpact} />
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function StressTesting({ ticker, onFreshness }: StressTestingProps) {
  // Fetched proactively (not from a stress result) so the Uncorrelated
  // sliders can be disabled for missing factors before the user ever runs
  // anything, not just after seeing a silently-zeroed result.
  const [fitMeta, setFitMeta] = useState<FitMeta>({
    factorsMissing: [], nFactors: 12, nObs: null, firstDate: null,
  });

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    getExposures(ticker)
      .then((exp) => {
        if (!cancelled) {
          setFitMeta({
            factorsMissing: exp.factorsMissing,
            nFactors:       exp.nFactors,
            nObs:           exp.nObs,
            firstDate:      exp.firstDate,
          });
        }
      })
      .catch(() => { /* banner just stays empty — sliders behave as if nothing is missing */ });
    return () => { cancelled = true; };
  }, [ticker]);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Stress Testing — {ticker}</h2>

      <DegradedModelBanner
        factorsMissing={fitMeta.factorsMissing}
        nFactors={fitMeta.nFactors}
        nObs={fitMeta.nObs}
        firstDate={fitMeta.firstDate}
      />

      <Tabs defaultValue="historical" onValueChange={() => onFreshness?.({ asOf: null, source: null })}>
        <TabsList>
          <TabsTrigger value="historical">Historical</TabsTrigger>
          <TabsTrigger value="uncorrelated">Uncorrelated shocks</TabsTrigger>
          <TabsTrigger value="correlated">Correlated shock</TabsTrigger>
        </TabsList>
        <TabsContent value="historical">
          <Card><CardContent className="pt-6"><HistoricalTab ticker={ticker} onFreshness={onFreshness} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="uncorrelated">
          <Card><CardContent className="pt-6">
            <UncorrelatedTab ticker={ticker} onFreshness={onFreshness} factorsMissing={fitMeta.factorsMissing} />
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="correlated">
          <Card><CardContent className="pt-6"><CorrelatedTab ticker={ticker} onFreshness={onFreshness} /></CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
