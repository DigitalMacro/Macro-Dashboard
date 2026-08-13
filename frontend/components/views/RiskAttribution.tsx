"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard, MetricCardSkeleton } from "@/components/dashboard/MetricCard";
import { DegradedModelBanner } from "@/components/dashboard/DegradedModelBanner";
import { FactorBarChart } from "@/components/charts/FactorBarChart";
import { VolDecompChart } from "@/components/charts/VolDecompChart";
import { getRisk, getRollingRisk } from "@/lib/api";
import type { RiskAttribution as RiskAttr, RollingRisk } from "@/lib/types";
import { FACTOR_LABELS } from "@/lib/constants";

interface RiskAttributionProps {
  ticker: string;
  onFreshness?: (freshness: { asOf: string | null; source: string | null }) => void;
}

export function RiskAttribution({ ticker, onFreshness }: RiskAttributionProps) {
  const [risk,        setRisk]        = useState<RiskAttr | null>(null);
  const [rollingRisk, setRollingRisk] = useState<RollingRisk | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([getRisk(ticker), getRollingRisk(ticker)])
      .then(([r, roll]) => {
        if (!cancelled) {
          setRisk(r);
          setRollingRisk(roll);
          setLoading(false);
          onFreshness?.({ asOf: r.asOf, source: r.source });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [ticker]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-red-600 text-sm">{error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Risk Attribution — {ticker}</h2>

      {risk && (
        <DegradedModelBanner
          factorsMissing={risk.factorsMissing}
          nFactors={risk.nFactors}
          nObs={risk.nObs}
          firstDate={risk.firstDate}
        />
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <MetricCardSkeleton key={i} />)
        ) : (
          <>
            {/* Backend vols are already in annualised % units (returns are pct_change × 100) */}
            <MetricCard
              title="Total vol (ann.)"
              value={risk ? `${risk.totalVol.toFixed(1)}%` : "—"}
              positive={null}
            />
            <MetricCard
              title="Factor vol"
              value={risk ? `${risk.factorVol.toFixed(1)}%` : "—"}
              positive={null}
              subtitle="Explained by macro factors"
            />
            <MetricCard
              title="Specific vol"
              value={risk ? `${risk.specificVol.toFixed(1)}%` : "—"}
              positive={null}
              subtitle="Idiosyncratic risk"
            />
            <MetricCard
              title="Factor share"
              value={risk ? `${(risk.factorShare * 100).toFixed(1)}%` : "—"}
              positive={null}
              subtitle="% of variance explained"
            />
          </>
        )}
      </div>

      {/* MCTR bar chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Marginal contribution to risk (MCTR)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-80 animate-pulse rounded bg-muted" />
          ) : risk?.mctr && Object.keys(risk.mctr).length > 0 ? (
            <FactorBarChart
              data={risk.mctr}
              valueLabel="MCTR (ann. %)"
              formatValue={(v) => `${v.toFixed(2)}%`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No MCTR data available</p>
          )}
        </CardContent>
      </Card>

      {/* Rolling vol stacked area */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Rolling 30d vol decomposition</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-72 animate-pulse rounded bg-muted" />
          ) : rollingRisk && rollingRisk.dates.length > 0 ? (
            <VolDecompChart
              dates={rollingRisk.dates}
              factorVol={rollingRisk.factorVol}
              specificVol={rollingRisk.specificVol}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No rolling risk data</p>
          )}
        </CardContent>
      </Card>

      {/* Snapshot table */}
      {!loading && risk && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Risk snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 text-left font-medium text-muted-foreground">Factor</th>
                    <th className="py-2 text-right font-medium text-muted-foreground">MCTR (ann. %)</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(risk.mctr)
                    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
                    .map(([factor, val]) => (
                      <tr key={factor} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="py-1.5">{FACTOR_LABELS[factor] ?? factor}</td>
                        <td className={`py-1.5 text-right tabular-nums ${val >= 0 ? "text-green-700" : "text-red-700"}`}>
                          {val >= 0 ? "+" : ""}{val.toFixed(3)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
