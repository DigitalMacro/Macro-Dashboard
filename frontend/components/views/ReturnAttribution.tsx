"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard, MetricCardSkeleton } from "@/components/dashboard/MetricCard";
import { DateRangePicker } from "@/components/dashboard/DateRangePicker";
import { DegradedModelBanner } from "@/components/dashboard/DegradedModelBanner";
import { FactorBarChart } from "@/components/charts/FactorBarChart";
import { CumulativeReturnChart } from "@/components/charts/CumulativeReturnChart";
import { getAttribution, getExposures } from "@/lib/api";
import type { Attribution, FactorExposures } from "@/lib/types";
import { getDateRangeDates } from "@/lib/utils";

interface ReturnAttributionProps {
  ticker: string;
  onFreshness?: (freshness: { asOf: string | null; source: string | null }) => void;
}

export function ReturnAttribution({ ticker, onFreshness }: ReturnAttributionProps) {
  const [dateRange,  setDateRange]  = useState("1Y");
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [exposures,   setExposures]   = useState<FactorExposures | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const { start, end } = getDateRangeDates(dateRange);

    Promise.all([
      getAttribution(ticker, start, end),
      getExposures(ticker),
    ])
      .then(([attr, exp]) => {
        if (!cancelled) {
          setAttribution(attr);
          setExposures(exp);
          setLoading(false);
          onFreshness?.({ asOf: attr.asOf, source: attr.source });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [ticker, dateRange]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-red-600 text-sm">{error}</CardContent>
      </Card>
    );
  }

  // Build per-factor cumulative contribution for bar chart
  const factorContribs: Record<string, number> = {};
  if (attribution?.factorBreakdown) {
    for (const [factor, dailyArr] of Object.entries(attribution.factorBreakdown)) {
      factorContribs[factor] = dailyArr.reduce((s, v) => s + v, 0);
    }
  }

  const s = attribution?.summary;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Return Attribution — {ticker}</h2>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {attribution && (
        <DegradedModelBanner
          factorsMissing={attribution.factorsMissing}
          nFactors={attribution.nFactors}
          nObs={attribution.nObs}
          firstDate={attribution.firstDate}
        />
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <MetricCardSkeleton key={i} />)
        ) : (
          <>
            <MetricCard
              title="Spot return"
              value={s ? `${s.totalReturn >= 0 ? "+" : ""}${s.totalReturn.toFixed(2)}%` : "—"}
              positive={s ? s.totalReturn >= 0 : null}
            />
            <MetricCard
              title="Factor return"
              value={s ? `${s.factorReturn >= 0 ? "+" : ""}${s.factorReturn.toFixed(2)}%` : "—"}
              positive={s ? s.factorReturn >= 0 : null}
              subtitle="Explained by 12 macro factors"
            />
            <MetricCard
              title="Specific return"
              value={s ? `${s.specificReturn >= 0 ? "+" : ""}${s.specificReturn.toFixed(2)}%` : "—"}
              positive={s ? s.specificReturn >= 0 : null}
              subtitle="Idiosyncratic / unexplained"
            />
            <MetricCard
              title="R²"
              value={exposures ? `${(exposures.rsquared * 100).toFixed(1)}%` : "—"}
              positive={null}
              subtitle="Model fit quality"
            />
          </>
        )}
      </div>

      {/* Factor bar chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Factor contributions (cumulative)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-80 animate-pulse rounded bg-muted" />
          ) : Object.keys(factorContribs).length > 0 ? (
            <FactorBarChart
              data={factorContribs}
              valueLabel="Contribution (%)"
              formatValue={(v) => `${v.toFixed(2)}%`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No factor data for selected range</p>
          )}
        </CardContent>
      </Card>

      {/* Cumulative return line chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Cumulative return decomposition</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-72 animate-pulse rounded bg-muted" />
          ) : attribution && attribution.dates.length > 0 ? (
            <CumulativeReturnChart
              dates={attribution.dates}
              actualReturn={attribution.actualReturn}
              factorReturn={attribution.factorReturn}
              specificReturn={attribution.specificReturn}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No return data for selected range</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
