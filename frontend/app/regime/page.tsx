"use client";

/**
 * RegimeView.tsx — Regime Matrix Module
 * Drop into: app/regime/page.tsx  (or import into your tab router)
 *
 * Deps already in your stack:
 *   recharts, tailwind, lucide-react
 *
 * API: GET /api/regime/snapshot?method=roc&roc_window=3&market_weight=0.4
 */

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import { RefreshCw, TrendingUp, TrendingDown, Clock, Activity } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface QuadrantMeta {
  label: string;
  growth: string;
  inflation: string;
  color: string;
}

interface TimeSeriesPoint {
  date: string;
  growth: number;
  inflation: number;
  regime: string;
}

interface AssetHeatmap {
  [asset: string]: {
    [regime: string]: number | null;
  };
}

interface RegimeSnapshot {
  current_regime: string;
  current_growth: number;
  current_inflation: number;
  days_in_regime: number;
  growth_roc: number;
  inflation_roc: number;
  method: string;
  quadrants: { [key: string]: QuadrantMeta };
  time_series: TimeSeriesPoint[];
  asset_heatmap: AssetHeatmap;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const QUADRANT_DESCRIPTIONS: Record<string, string> = {
  run_it_hot:  "Growth accelerating with rising inflation. Risk assets outperform. Commodities and inflation-linked bonds in favour.",
  stagflation: "Growth deteriorating with rising inflation. Most challenging environment for portfolios. Cash and real assets preferred.",
  goldilocks:  "Growth accelerating with easing inflation. Ideal for both equities and duration. Risk-on with quality bias.",
  debasement:  "Growth deteriorating with falling inflation. Flight to quality, duration outperforms. Deflation risk elevated.",
};

const QUADRANT_AXIS_LABELS: Record<string, string> = {
  run_it_hot:  "GROWTH+ / INFLATION+",
  stagflation: "GROWTH− / INFLATION+",
  goldilocks:  "GROWTH+ / INFLATION−",
  debasement:  "GROWTH− / INFLATION−",
};

const REGIME_COLORS: Record<string, string> = {
  run_it_hot:  "#B45309",
  stagflation: "#991B1B",
  goldilocks:  "#166534",
  debasement:  "#1E3A5F",
};

const REGIME_BG: Record<string, string> = {
  run_it_hot:  "rgba(180,83,9,0.15)",
  stagflation: "rgba(153,27,27,0.25)",
  goldilocks:  "rgba(22,101,52,0.15)",
  debasement:  "rgba(30,58,95,0.15)",
};

const HEATMAP_ASSETS = ["SPX", "Bonds", "Gold", "Cmdty", "BTC", "TIPS", "HY"];
const HEATMAP_REGIMES = ["run_it_hot", "stagflation", "goldilocks", "debasement"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function heatColor(val: number | null): string {
  if (val === null || isNaN(val)) return "bg-neutral-800 text-neutral-500";
  if (val >= 3)  return "bg-emerald-900/60 text-emerald-300";
  if (val >= 1)  return "bg-emerald-900/30 text-emerald-400";
  if (val >= 0)  return "bg-neutral-800 text-neutral-300";
  if (val >= -1) return "bg-red-900/30 text-red-400";
  return "bg-red-900/60 text-red-300";
}

function fmt(val: number | null, decimals = 1): string {
  if (val === null || val === undefined) return "—";
  const prefix = val > 0 ? "+" : "";
  return `${prefix}${val.toFixed(decimals)}%`;
}

// ── Regime shading bands for the chart ───────────────────────────────────────
function buildReferenceAreas(ts: TimeSeriesPoint[]) {
  if (!ts.length) return [];
  const bands: { start: string; end: string; regime: string }[] = [];
  let current = ts[0].regime;
  let start = ts[0].date;

  for (let i = 1; i < ts.length; i++) {
    if (ts[i].regime !== current) {
      bands.push({ start, end: ts[i].date, regime: current });
      current = ts[i].regime;
      start = ts[i].date;
    }
  }
  bands.push({ start, end: ts[ts.length - 1].date, regime: current });
  return bands;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, accent = false,
}: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-6 py-4 border-r border-neutral-800 last:border-0">
      <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">{label}</span>
      <span className={`text-2xl font-semibold font-mono tabular-nums ${accent ? "text-amber-400" : "text-white"}`}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-neutral-500">{sub}</span>}
    </div>
  );
}

function QuadrantGrid({
  current,
  quadrants,
}: {
  current: string;
  quadrants: Record<string, QuadrantMeta>;
}) {
  const layout = [
    ["run_it_hot", "stagflation"],
    ["goldilocks",  "debasement"],
  ];

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-px bg-neutral-800 rounded-lg overflow-hidden">
      {layout.flat().map((key) => {
        const q = quadrants[key];
        const active = key === current;
        return (
          <div
            key={key}
            className="relative p-5 transition-all duration-500"
            style={{
              background: active ? REGIME_BG[key] : "rgb(15 15 18)",
              borderLeft: active ? `3px solid ${REGIME_COLORS[key]}` : "3px solid transparent",
            }}
          >
            {active && (
              <span
                className="absolute top-3 right-3 text-[9px] font-mono tracking-widest px-2 py-0.5 rounded"
                style={{ background: REGIME_COLORS[key], color: "#fff" }}
              >
                CURRENT
              </span>
            )}
            <p
              className="text-base font-semibold mb-1"
              style={{ color: active ? REGIME_COLORS[key] : "#6b7280" }}
            >
              {q?.label ?? key}
            </p>
            <p className="text-xs text-neutral-400 leading-relaxed mb-2">
              {QUADRANT_DESCRIPTIONS[key]}
            </p>
            <p className="text-[10px] font-mono tracking-wider" style={{ color: active ? REGIME_COLORS[key] : "#4b5563" }}>
              {QUADRANT_AXIS_LABELS[key]}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function RegimeChart({ ts }: { ts: TimeSeriesPoint[] }) {
  const bands = buildReferenceAreas(ts);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={ts} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        {bands.map((b, i) => (
          <ReferenceArea
            key={i}
            x1={b.start}
            x2={b.end}
            fill={REGIME_BG[b.regime]}
            fillOpacity={1}
          />
        ))}
        <XAxis
          dataKey="date"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => v.slice(0, 7)}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => v.toFixed(1)}
          label={{ value: "Growth", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => v.toFixed(1)}
          label={{ value: "Inflation", angle: 90, position: "insideRight", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [v.toFixed(3), name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", paddingTop: 8 }}
        />
        <ReferenceLine yAxisId="left" y={0} stroke="#374151" strokeDasharray="4 4" />
        <Line yAxisId="left" type="monotone" dataKey="growth" stroke="#38bdf8" strokeWidth={1.5} dot={false} name="Growth Score" />
        <Line yAxisId="right" type="monotone" dataKey="inflation" stroke="#fb923c" strokeWidth={1.5} dot={false} name="Inflation Score" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function AssetHeatmap({
  heatmap,
  quadrants,
}: {
  heatmap: AssetHeatmap;
  quadrants: Record<string, QuadrantMeta>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left text-neutral-500 uppercase tracking-wider pb-2 pr-4 font-normal">Asset</th>
            {HEATMAP_REGIMES.map((r) => (
              <th key={r} className="text-center pb-2 px-2 font-normal" style={{ color: REGIME_COLORS[r] }}>
                {quadrants[r]?.label ?? r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {HEATMAP_ASSETS.map((asset) => (
            <tr key={asset} className="border-t border-neutral-800/50">
              <td className="py-2 pr-4 text-neutral-300 font-semibold">{asset}</td>
              {HEATMAP_REGIMES.map((regime) => {
                const val = heatmap[asset]?.[regime] ?? null;
                return (
                  <td key={regime} className={`py-2 px-2 text-center rounded ${heatColor(val)}`}>
                    {fmt(val)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-neutral-600 mt-2">
        Avg monthly return (%) by regime · 3yr lookback · yfinance
      </p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function RegimeView() {
  const [data, setData] = useState<RegimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<"roc" | "zscore">("roc");
  const [marketWeight, setMarketWeight] = useState(0.4);
  const [rocWindow, setRocWindow] = useState(3);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        method,
        roc_window: rocWindow.toString(),
        market_weight: marketWeight.toString(),
      });
      const res = await fetch(`/api/regime/snapshot?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: RegimeSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load regime data");
    } finally {
      setLoading(false);
    }
  }, [method, marketWeight, rocWindow]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const currentColor = data ? REGIME_COLORS[data.current_regime] ?? "#6b7280" : "#6b7280";
  const currentLabel = data ? (data.quadrants[data.current_regime]?.label ?? data.current_regime) : "—";

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE DASHBOARD
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Macro Regime Matrix</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            Growth &amp; inflation regime classification · blended rules + market signals
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 text-xs text-neutral-400 hover:text-white transition-colors border border-neutral-700 rounded px-3 py-1.5 hover:border-neutral-500 disabled:opacity-40"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-neutral-900/60 rounded-lg border border-neutral-800 text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 uppercase tracking-wider">Method</span>
          {(["roc", "zscore"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`px-3 py-1 rounded uppercase tracking-wider transition-all ${
                method === m
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                  : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {m === "roc" ? "Rate of Change" : "Z-Score"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 uppercase tracking-wider">Market Weight</span>
          {[0.2, 0.4, 0.6].map((w) => (
            <button
              key={w}
              onClick={() => setMarketWeight(w)}
              className={`px-2 py-1 rounded transition-all ${
                marketWeight === w
                  ? "bg-sky-500/20 text-sky-400 border border-sky-500/40"
                  : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {(w * 100).toFixed(0)}%
            </button>
          ))}
        </div>
        {method === "roc" && (
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 uppercase tracking-wider">Window</span>
            {[1, 3, 6].map((w) => (
              <button
                key={w}
                onClick={() => setRocWindow(w)}
                className={`px-2 py-1 rounded transition-all ${
                  rocWindow === w
                    ? "bg-sky-500/20 text-sky-400 border border-sky-500/40"
                    : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
                }`}
              >
                {w}M
              </button>
            ))}
          </div>
        )}
        {lastUpdated && (
          <span className="ml-auto text-neutral-600 flex items-center gap-1">
            <Clock className="w-3 h-3" /> {lastUpdated}
          </span>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-4 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
        <div className="flex flex-col gap-1 px-6 py-4">
          <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">Current Regime</span>
          <span className="text-2xl font-semibold font-mono" style={{ color: currentColor }}>
            {loading ? "—" : currentLabel}
          </span>
        </div>
        <KpiCard
          label="Growth Score"
          value={data ? data.growth_roc.toFixed(1) : "—"}
          sub={data && data.current_growth >= 0 ? "Accelerating" : "Slowing"}
        />
        <KpiCard
          label="Inflation Score"
          value={data ? data.inflation_roc.toFixed(1) : "—"}
          sub={data && data.current_inflation >= 0 ? "Rising" : "Falling"}
        />
        <KpiCard
          label="Days in Regime"
          value={data ? data.days_in_regime.toString() : "—"}
          sub="consecutive days"
        />
      </div>

      {/* ── Main Grid ── */}
      <div className="grid grid-cols-5 gap-5">

        {/* Quadrant 2×2 — 3 cols */}
        <div className="col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-3.5 h-3.5 text-neutral-500" />
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500">
              Regime Quadrant — Current State
            </span>
          </div>
          {data ? (
            <QuadrantGrid current={data.current_regime} quadrants={data.quadrants} />
          ) : (
            <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading regime data..." : "No data"}
            </div>
          )}

          {/* Axis labels */}
          <div className="flex justify-between mt-3 text-[10px] font-mono text-neutral-600">
            <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3 text-emerald-700" /> GROWTH+</span>
            <span className="flex items-center gap-1">GROWTH− <TrendingDown className="w-3 h-3 text-red-700" /></span>
          </div>
        </div>

        {/* Dot plot — 2 cols */}
        <div className="col-span-2 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
            Regime Position
          </span>
          {data ? (
            <div className="relative w-full aspect-square rounded bg-neutral-950 border border-neutral-800">
              {/* Axis labels */}
              <span className="absolute top-1/2 left-1 -translate-y-1/2 -rotate-90 text-[9px] font-mono text-neutral-600 origin-center">INFLATION</span>
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-mono text-neutral-600">GROWTH</span>

              {/* Quadrant shading */}
              <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 pointer-events-none rounded overflow-hidden">
                <div style={{ background: REGIME_BG["run_it_hot"] }} />
                <div style={{ background: REGIME_BG["stagflation"] }} />
                <div style={{ background: REGIME_BG["goldilocks"] }} />
                <div style={{ background: REGIME_BG["debasement"] }} />
              </div>

              {/* Crosshair */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-full h-px bg-neutral-800" />
              </div>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="h-full w-px bg-neutral-800" />
              </div>

              {/* Quadrant labels */}
              <span className="absolute top-2 left-3 text-[9px] font-mono text-neutral-600">Run It Hot</span>
              <span className="absolute top-2 right-3 text-[9px] font-mono text-neutral-600">Stagflation</span>
              <span className="absolute bottom-5 left-3 text-[9px] font-mono text-neutral-600">Goldilocks</span>
              <span className="absolute bottom-5 right-3 text-[9px] font-mono text-neutral-600">Debasement</span>

              {/* Live dot */}
              {(() => {
                // Map scores to % position: growth on x (left=negative, right=positive)
                // inflation on y (top=positive, bottom=negative)
                const clamp = (v: number) => Math.max(-3, Math.min(3, v));
                const gx = ((clamp(data.current_growth) + 3) / 6) * 100;
                const iy = ((3 - clamp(data.current_inflation)) / 6) * 100;
                return (
                  <div
                    className="absolute w-4 h-4 rounded-full border-2 border-white shadow-lg transition-all duration-700"
                    style={{
                      left: `calc(${gx}% - 8px)`,
                      top: `calc(${iy}% - 8px)`,
                      background: currentColor,
                      boxShadow: `0 0 12px ${currentColor}`,
                    }}
                  >
                    <div className="absolute inset-0 rounded-full animate-ping opacity-40"
                      style={{ background: currentColor }} />
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="aspect-square flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
          {data && (
            <div className="mt-3 flex justify-between text-[10px] font-mono text-neutral-500">
              <span>G: {data.current_growth.toFixed(2)}</span>
              <span>I: {data.current_inflation.toFixed(2)}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Regime Time Series ── */}
      <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
          Regime Model — {method === "roc" ? "Rate of Change" : "Z-Score"} with Regime Shading
        </span>
        {data?.time_series?.length ? (
          <RegimeChart ts={data.time_series} />
        ) : (
          <div className="h-52 flex items-center justify-center text-neutral-600 text-sm">
            {loading ? "Building time series..." : "No data"}
          </div>
        )}
      </div>

      {/* ── Asset Heatmap ── */}
      <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
          Asset Returns by Regime — Avg Monthly Return (%)
        </span>
        {data?.asset_heatmap ? (
          <AssetHeatmap heatmap={data.asset_heatmap} quadrants={data.quadrants} />
        ) : (
          <div className="h-40 flex items-center justify-center text-neutral-600 text-sm">
            {loading ? "Computing asset returns..." : "No data"}
          </div>
        )}
      </div>

    </div>
  );
}
