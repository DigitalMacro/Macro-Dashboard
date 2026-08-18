"use client";

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DegradedModelBanner } from "@/components/dashboard/DegradedModelBanner";
import { getExposures } from "@/lib/api";
import type { FactorExposures, HeatmapRow } from "@/lib/types";
import { FACTOR_LABELS, HEATMAP_THRESHOLDS } from "@/lib/constants";
import { Plus, Trash2, Download, Loader2 } from "lucide-react";

// Diagonal hatch — visually distinct from the green/red heat scale so a
// missing factor never reads as a measured value.
const HATCH_BG =
  "repeating-linear-gradient(45deg, #e5e7eb, #e5e7eb 4px, #f3f4f6 4px, #f3f4f6 8px)";

const FACTOR_COLS = [
  "economic_growth", "metals", "energy", "fwd_growth_expectations",
  "inflation", "ig_credit_spread", "10y_yield", "real_rates",
  "cb_rate_expectations", "dm_fx", "rate_vol", "risk_aversion",
];

function getCellColour(value: number): string {
  for (const t of HEATMAP_THRESHOLDS) {
    if (value >= t.min) return t.colour;
  }
  return HEATMAP_THRESHOLDS[HEATMAP_THRESHOLDS.length - 1].colour;
}

function getCellTextColour(bgColour: string): string {
  const dark = ["#15803d", "#dc2626", "#b91c1c"];
  return dark.includes(bgColour) ? "#ffffff" : "#111827";
}

interface ExposureHeatmapProps {
  initialTicker?: string;
  onFreshness?: (freshness: { asOf: string | null; source: string | null }) => void;
}

export function ExposureHeatmap({ initialTicker = "SPY", onFreshness }: ExposureHeatmapProps) {
  const [rows,    setRows]    = useState<HeatmapRow[]>([]);
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error,   setError]   = useState<string | null>(null);
  // All rows share one factor matrix, so factorsMissing is the same for
  // every ticker — the latest successful fetch's value is authoritative.
  const [fitMeta, setFitMeta] = useState<{
    factorsMissing: string[]; nFactors: number; nObs: number | null; firstDate: string | null;
  }>({ factorsMissing: [], nFactors: 12, nObs: null, firstDate: null });

  const addTicker = useCallback(async (ticker: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t || rows.some((r) => r.ticker === t)) return;

    setLoading((prev) => ({ ...prev, [t]: true }));
    setError(null);
    try {
      const exp: FactorExposures = await getExposures(t);
      setRows((prev) => [
        ...prev,
        { ticker: t, name: t, exposures: exp.exposures },
      ]);
      setFitMeta({
        factorsMissing: exp.factorsMissing,
        nFactors:       exp.nFactors,
        nObs:           exp.nObs,
        firstDate:      exp.firstDate,
      });
      onFreshness?.({ asOf: exp.asOf, source: exp.source });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Failed to load ${t}`);
    } finally {
      setLoading((prev) => ({ ...prev, [t]: false }));
    }
    setInput("");
  }, [rows]);

  function removeRow(ticker: string) {
    setRows((prev) => prev.filter((r) => r.ticker !== ticker));
  }

  // Equal-weighted aggregate exposure
  const aggRow: HeatmapRow | null =
    rows.length > 1
      ? {
          ticker: "Portfolio",
          name:   "Equal-weight avg",
          exposures: Object.fromEntries(
            FACTOR_COLS.map((f) => [
              f,
              rows.reduce((s, r) => s + (r.exposures[f] ?? 0), 0) / rows.length,
            ]),
          ),
        }
      : null;

  function exportCsv() {
    const allRows = aggRow ? [...rows, aggRow] : rows;
    const header  = ["Ticker", ...FACTOR_COLS.map((f) => FACTOR_LABELS[f] ?? f)].join(",");
    const lines   = allRows.map((r) =>
      [
        r.ticker,
        ...FACTOR_COLS.map((f) =>
          fitMeta.factorsMissing.includes(f) ? "N/A" : (r.exposures[f] ?? 0).toFixed(4)
        ),
      ].join(","),
    );
    const csv  = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "mferm_exposures.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Macro Exposure Heatmap</h2>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-4 w-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <DegradedModelBanner
        factorsMissing={fitMeta.factorsMissing}
        nFactors={fitMeta.nFactors}
        nObs={fitMeta.nObs}
        firstDate={fitMeta.firstDate}
      />

      {/* Add ticker */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <form
            onSubmit={(e) => { e.preventDefault(); addTicker(input); }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              placeholder="Add ticker (e.g. AAPL, XLF, TLT)"
              className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button type="submit" size="sm" disabled={!input.trim()}>
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </form>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {/* Colour legend */}
      <div className="flex gap-2 flex-wrap">
        {HEATMAP_THRESHOLDS.map((t) => (
          <div key={t.colour} className="flex items-center gap-1 text-xs">
            <div className="h-3 w-6 rounded" style={{ backgroundColor: t.colour }} />
            <span className="text-muted-foreground">{t.label}</span>
          </div>
        ))}
      </div>

      {/* Heatmap table */}
      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Add tickers above to build your exposure heatmap
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4 overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[900px]">
              <thead>
                <tr>
                  <th className="py-2 px-3 text-left font-medium text-muted-foreground sticky left-0 bg-background border-b">
                    Ticker
                  </th>
                  {FACTOR_COLS.map((f) => {
                    const isMissing = fitMeta.factorsMissing.includes(f);
                    return (
                      <th key={f} className="py-2 px-1 text-center font-medium text-muted-foreground border-b" style={{ maxWidth: 70 }}>
                        <span
                          className="block truncate"
                          title={isMissing ? `${FACTOR_LABELS[f]} — not in this fit` : FACTOR_LABELS[f]}
                        >
                          {(FACTOR_LABELS[f] ?? f).split(" ").slice(0, 2).join(" ")}
                          {isMissing && <span className="text-amber-600"> †</span>}
                        </span>
                      </th>
                    );
                  })}
                  <th className="py-2 px-2 border-b" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.ticker} className="hover:bg-muted/30">
                    <td className="py-2 px-3 font-semibold sticky left-0 bg-background border-b">
                      {loading[row.ticker] ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        row.ticker
                      )}
                    </td>
                    {FACTOR_COLS.map((f) => {
                      if (fitMeta.factorsMissing.includes(f)) {
                        return (
                          <td
                            key={f}
                            className="py-2 px-1 text-center tabular-nums border-b text-muted-foreground"
                            style={{ backgroundImage: HATCH_BG, minWidth: 60 }}
                            title={`${FACTOR_LABELS[f]} — Not in this fit — see note above`}
                          >
                            —
                          </td>
                        );
                      }
                      const val = row.exposures[f] ?? 0;
                      const bg  = getCellColour(val);
                      const fg  = getCellTextColour(bg);
                      return (
                        <td
                          key={f}
                          className="py-2 px-1 text-center tabular-nums border-b"
                          style={{ backgroundColor: bg, color: fg, minWidth: 60 }}
                          title={`${FACTOR_LABELS[f]}: ${val.toFixed(4)}`}
                        >
                          {val.toFixed(2)}
                        </td>
                      );
                    })}
                    <td className="py-2 px-2 border-b">
                      <button onClick={() => removeRow(row.ticker)} className="text-muted-foreground hover:text-red-600">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}

                {/* Aggregate row */}
                {aggRow && (
                  <tr className="bg-muted/50 font-semibold">
                    <td className="py-2 px-3 sticky left-0 bg-muted/50 text-xs text-muted-foreground">
                      EW Portfolio
                    </td>
                    {FACTOR_COLS.map((f) => {
                      if (fitMeta.factorsMissing.includes(f)) {
                        return (
                          <td
                            key={f}
                            className="py-2 px-1 text-center tabular-nums text-muted-foreground"
                            style={{ backgroundImage: HATCH_BG }}
                            title={`${FACTOR_LABELS[f]} — Not in this fit — see note above`}
                          >
                            —
                          </td>
                        );
                      }
                      const val = aggRow.exposures[f] ?? 0;
                      const bg  = getCellColour(val);
                      const fg  = getCellTextColour(bg);
                      return (
                        <td
                          key={f}
                          className="py-2 px-1 text-center tabular-nums"
                          style={{ backgroundColor: bg, color: fg }}
                        >
                          {val.toFixed(2)}
                        </td>
                      );
                    })}
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
