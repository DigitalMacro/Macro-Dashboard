"use client";

/**
 * Yield Curve Regime — app/yield-curve/page.tsx
 *
 * 2s10s steepener / flattener / twist classification from FRED daily data.
 * API: GET /api/yield-curve/snapshot?method=roc&window=21
 */

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import { RefreshCw, Clock, Activity, AlertTriangle } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface RegimeMeta {
  label: string;
  color: string;
  description: string;
}

interface TimeSeriesPoint {
  date: string;
  yield_2y: number;
  yield_10y: number;
  spread: number;
  regime: string;
}

// Decomposed (real / inflation) series — 5s10s legs, FRED has no 2Y TIPS
interface DecompPoint {
  date: string;
  yield_5y: number;
  yield_10y: number;
  spread: number;
  regime: string;
}

interface AssetHeatmap {
  [asset: string]: {
    [regime: string]: number | null;
  };
}

interface YieldCurveSnapshot {
  current_regime: string;
  yield_2y: number;
  yield_10y: number;
  spread_bps: number;
  spread_change_bps: number;
  days_in_regime: number;
  inverted: boolean;
  d2y: number;
  d10y: number;
  method: string;
  window: number;
  regimes: { [key: string]: RegimeMeta };
  time_series: TimeSeriesPoint[];
  asset_heatmap: AssetHeatmap;
  // ── Upgrade: decomposed real/inflation curves (5s10s) ──
  decomp_short_tenor: string;
  decomp_note: string;
  real_5y: number;
  real_10y: number;
  real_spread_bps: number;
  real_spread_change_bps: number;
  real_regime: string;
  real_days_in_regime: number;
  real_d5y: number;
  real_d10y: number;
  inflation_5y: number;
  inflation_10y: number;
  inflation_spread_bps: number;
  inflation_spread_change_bps: number;
  inflation_regime: string;
  inflation_days_in_regime: number;
  inflation_d5y: number;
  inflation_d10y: number;
  regime_agreement: boolean;
  divergent_curves: string[];
  real_time_series: DecompPoint[];
  inflation_time_series: DecompPoint[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const REGIME_COLORS: Record<string, string> = {
  bull_steepener: "#166534",
  bear_steepener: "#991B1B",
  bull_flattener: "#1E3A5F",
  bear_flattener: "#B45309",
  twist_bear:     "#6B21A8",
  twist_bull:     "#0E7490",
  neutral:        "#374151",
};

const REGIME_BG: Record<string, string> = {
  bull_steepener: "rgba(22,101,52,0.18)",
  bear_steepener: "rgba(153,27,27,0.18)",
  bull_flattener: "rgba(30,58,95,0.22)",
  bear_flattener: "rgba(180,83,9,0.16)",
  twist_bear:     "rgba(107,33,168,0.18)",
  twist_bull:     "rgba(14,116,144,0.18)",
  neutral:        "rgba(0,0,0,0)", // no shading — "no dominant trend"
};

const REGIME_CONDITIONS: Record<string, string> = {
  bull_steepener: "2Y ↓ / 10Y ↓ · SPREAD WIDER",
  bear_steepener: "2Y ↑ / 10Y ↑ · SPREAD WIDER",
  bull_flattener: "2Y ↓ / 10Y ↓ · SPREAD TIGHTER",
  bear_flattener: "2Y ↑ / 10Y ↑ · SPREAD TIGHTER",
  twist_bull:     "2Y ↓ / 10Y ↑ · CURVE TWIST",
  twist_bear:     "2Y ↑ / 10Y ↓ · CURVE TWIST",
};

// 2×3 layout per spec: steepeners / flatteners / twists
const GRID_LAYOUT: string[][] = [
  ["bull_steepener", "bear_steepener"],
  ["bull_flattener", "bear_flattener"],
  ["twist_bull", "twist_bear"],
];

const HEATMAP_ASSETS = ["SPX", "TLT", "GLD", "BTC", "HY", "TIPS"];
const HEATMAP_ASSET_LABELS: Record<string, string> = {
  SPX: "SPX", TLT: "TLT", GLD: "GLD", BTC: "BTC", HY: "HYG", TIPS: "TIPS",
};
const HEATMAP_REGIMES = [
  "bull_steepener", "bear_steepener", "bull_flattener",
  "bear_flattener", "twist_bull", "twist_bear",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function heatColor(val: number | null): string {
  if (val === null || isNaN(val)) return "bg-neutral-800 text-neutral-500";
  if (val >= 3)  return "bg-emerald-900/60 text-emerald-300";
  if (val >= 1)  return "bg-emerald-900/30 text-emerald-400";
  if (val >= 0)  return "bg-neutral-800 text-neutral-300";
  if (val >= -1) return "bg-red-900/30 text-red-400";
  return "bg-red-900/60 text-red-300";
}

function fmtPct(val: number | null, decimals = 1): string {
  if (val === null || val === undefined) return "—";
  const prefix = val > 0 ? "+" : "";
  return `${prefix}${val.toFixed(decimals)}%`;
}

function buildReferenceAreas(ts: { date: string; regime: string }[]) {
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
  return bands.filter((b) => b.regime !== "neutral");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">{label}</span>
      <span
        className="text-xl font-semibold font-mono tabular-nums"
        style={{ color: color ?? "#F0F0F0" }}
      >
        {value}
      </span>
      {sub && <span className="text-[11px] text-neutral-500">{sub}</span>}
    </div>
  );
}

function RegimeGrid({
  current,
  regimes,
}: {
  current: string;
  regimes: Record<string, RegimeMeta>;
}) {
  return (
    <div className="grid grid-cols-2 gap-px bg-neutral-800 rounded-lg overflow-hidden">
      {GRID_LAYOUT.flat().map((key) => {
        const meta = regimes[key];
        const active = key === current;
        return (
          <div
            key={key}
            className="relative p-4 transition-all duration-500"
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
              className="text-sm font-semibold mb-1"
              style={{ color: active ? REGIME_COLORS[key] : "#6b7280" }}
            >
              {meta?.label ?? key}
            </p>
            <p className="text-xs text-neutral-400 leading-relaxed mb-2">
              {meta?.description ?? ""}
            </p>
            <p
              className="text-[10px] font-mono tracking-wider"
              style={{ color: active ? REGIME_COLORS[key] : "#4b5563" }}
            >
              {REGIME_CONDITIONS[key]}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// Custom tooltip: date + both yields + spread + regime
interface TooltipPayloadItem {
  payload?: TimeSeriesPoint;
}

function CurveTooltip({
  active, payload, label, regimes,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  regimes: Record<string, RegimeMeta>;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const p = payload[0].payload;
  const meta = regimes[p.regime];
  return (
    <div className="bg-[#0f0f12] border border-neutral-700 rounded-md px-3 py-2 text-[11px] font-mono space-y-0.5">
      <p className="text-neutral-400">{label}</p>
      <p className="text-[#38bdf8]">2Y &nbsp;{p.yield_2y.toFixed(2)}%</p>
      <p className="text-[#fb923c]">10Y {p.yield_10y.toFixed(2)}%</p>
      <p className={p.spread < 0 ? "text-red-400" : "text-neutral-300"}>
        SPREAD {p.spread >= 0 ? "+" : ""}{p.spread.toFixed(0)} bps
      </p>
      <p style={{ color: REGIME_COLORS[p.regime] ?? "#6b7280" }}>
        {meta?.label ?? p.regime}
      </p>
    </div>
  );
}

function YieldChart({
  ts, regimes,
}: {
  ts: TimeSeriesPoint[];
  regimes: Record<string, RegimeMeta>;
}) {
  const bands = buildReferenceAreas(ts);

  // Shared domain across both axes so the 2Y/10Y crossing point = inversion
  const values = ts.flatMap((p) => [p.yield_2y, p.yield_10y]);
  const yMin = Math.floor(Math.min(...values) * 10) / 10 - 0.1;
  const yMax = Math.ceil(Math.max(...values) * 10) / 10 + 0.1;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={ts} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        {bands.map((b, i) => (
          <ReferenceArea
            key={i}
            yAxisId="left"
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
          tickFormatter={(v: string) => v.slice(0, 7)}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          yAxisId="left"
          domain={[yMin, yMax]}
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: "2Y %", angle: -90, position: "insideLeft", fill: "#38bdf8", fontSize: 10 }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          domain={[yMin, yMax]}
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: "10Y %", angle: 90, position: "insideRight", fill: "#fb923c", fontSize: 10 }}
        />
        <Tooltip content={<CurveTooltip regimes={regimes} />} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", paddingTop: 8 }}
        />
        <Line yAxisId="left" type="monotone" dataKey="yield_2y" stroke="#38bdf8" strokeWidth={1.5} dot={false} name="2Y Yield" />
        <Line yAxisId="right" type="monotone" dataKey="yield_10y" stroke="#fb923c" strokeWidth={1.5} dot={false} name="10Y Yield" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SpreadChart({
  ts, regimes,
}: {
  ts: TimeSeriesPoint[];
  regimes: Record<string, RegimeMeta>;
}) {
  const bands = buildReferenceAreas(ts);

  // Gradient split point: fraction of the plot height above zero
  const spreads = ts.map((p) => p.spread);
  const sMax = Math.max(...spreads, 0);
  const sMin = Math.min(...spreads, 0);
  const zeroOffset = sMax === sMin ? 0.5 : sMax / (sMax - sMin);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={ts} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="spreadFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset={zeroOffset} stopColor="#34d399" stopOpacity={0.25} />
            <stop offset={zeroOffset} stopColor="#f87171" stopOpacity={0.25} />
          </linearGradient>
          <linearGradient id="spreadStroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset={zeroOffset} stopColor="#34d399" />
            <stop offset={zeroOffset} stopColor="#f87171" />
          </linearGradient>
        </defs>
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
          tickFormatter={(v: string) => v.slice(0, 7)}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v.toFixed(0)}`}
          label={{ value: "bps", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip content={<CurveTooltip regimes={regimes} />} />
        <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
        <Area
          type="monotone"
          dataKey="spread"
          stroke="url(#spreadStroke)"
          strokeWidth={1.5}
          fill="url(#spreadFill)"
          name="2s10s Spread"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Three-curve regime banner ─────────────────────────────────────────────────
function RegimeChip({
  curve, regime, days, regimes,
}: {
  curve: string;
  regime: string;
  days: number;
  regimes: Record<string, RegimeMeta>;
}) {
  return (
    <span className="flex items-center gap-2 text-xs font-mono">
      <span className="text-neutral-500 tracking-widest">{curve}</span>
      <span className="uppercase tracking-wider font-semibold" style={{ color: REGIME_COLORS[regime] ?? "#6b7280" }}>
        {regimes[regime]?.label ?? regime}
      </span>
      <span className="text-neutral-600">{days}D</span>
    </span>
  );
}

function ThreeCurveBanner({ data }: { data: YieldCurveSnapshot }) {
  const n = data.divergent_curves.length;
  return (
    <div className="bg-neutral-900/60 border border-neutral-800 rounded-lg p-4 flex flex-wrap items-center gap-x-8 gap-y-2">
      <RegimeChip curve="NOM" regime={data.current_regime} days={data.days_in_regime} regimes={data.regimes} />
      <RegimeChip curve="REAL" regime={data.real_regime} days={data.real_days_in_regime} regimes={data.regimes} />
      <RegimeChip curve="INF" regime={data.inflation_regime} days={data.inflation_days_in_regime} regimes={data.regimes} />
      <span className="ml-auto text-xs font-mono tracking-wider">
        {data.regime_agreement ? (
          <span className="text-emerald-400">■ ALL ALIGNED</span>
        ) : (
          <span className="text-amber-400">
            ▲ {n} DIVERGENT
            <span className="text-neutral-500 ml-2 uppercase">
              {data.divergent_curves.join(" · ")}
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

// ── Decomposed spread chart (real / inflation 5s10s) ─────────────────────────
function DecompTooltip({
  active, payload, label, regimes, name,
}: {
  active?: boolean;
  payload?: { payload?: DecompPoint }[];
  label?: string;
  regimes: Record<string, RegimeMeta>;
  name: string;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-[#0f0f12] border border-neutral-700 rounded-md px-3 py-2 text-[11px] font-mono space-y-0.5">
      <p className="text-neutral-400">{label}</p>
      <p className="text-neutral-300">
        {name} {p.spread >= 0 ? "+" : ""}{p.spread.toFixed(0)} bps
      </p>
      <p style={{ color: REGIME_COLORS[p.regime] ?? "#6b7280" }}>
        {regimes[p.regime]?.label ?? p.regime}
      </p>
    </div>
  );
}

function DecompSpreadChart({
  ts, regimes, posColor, gradientId, name,
}: {
  ts: DecompPoint[];
  regimes: Record<string, RegimeMeta>;
  posColor: string;
  gradientId: string;
  name: string;
}) {
  const bands = buildReferenceAreas(ts);
  const spreads = ts.map((p) => p.spread);
  const sMax = Math.max(...spreads, 0);
  const sMin = Math.min(...spreads, 0);
  const zeroOffset = sMax === sMin ? 0.5 : sMax / (sMax - sMin);

  return (
    <ResponsiveContainer width="100%" height={190}>
      <AreaChart data={ts} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`${gradientId}Fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset={zeroOffset} stopColor={posColor} stopOpacity={0.2} />
            <stop offset={zeroOffset} stopColor="#f87171" stopOpacity={0.2} />
          </linearGradient>
          <linearGradient id={`${gradientId}Stroke`} x1="0" y1="0" x2="0" y2="1">
            <stop offset={zeroOffset} stopColor={posColor} />
            <stop offset={zeroOffset} stopColor="#f87171" />
          </linearGradient>
        </defs>
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
          tickFormatter={(v: string) => v.slice(0, 7)}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v.toFixed(0)}`}
          label={{ value: "bps", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip content={<DecompTooltip regimes={regimes} name={name} />} />
        <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
        <Area
          type="monotone"
          dataKey="spread"
          stroke={`url(#${gradientId}Stroke)`}
          strokeWidth={1.5}
          fill={`url(#${gradientId}Fill)`}
          name={name}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function DecompMiniPanel({
  title, spread, change, window, regime, days, regimes, accent,
}: {
  title: string;
  spread: number;
  change: number;
  window: number;
  regime: string;
  days: number;
  regimes: Record<string, RegimeMeta>;
  accent: string;
}) {
  return (
    <div
      className="rounded-md p-4 space-y-1.5 text-[11px] font-mono"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <p className="text-sm font-semibold tabular-nums" style={{ color: accent }}>
        {title} {spread >= 0 ? "+" : ""}{spread.toFixed(0)}bp
      </p>
      <p className="text-neutral-400">
        Δ {window}D{" "}
        <span style={{ color: change >= 0 ? "#34d399" : "#f87171" }}>
          {change >= 0 ? "+" : ""}{change.toFixed(0)}bp
        </span>
      </p>
      <p className="text-neutral-500 uppercase tracking-wider text-[10px]">
        Regime:{" "}
        <span style={{ color: REGIME_COLORS[regime] ?? "#6b7280" }}>
          {regimes[regime]?.label ?? regime}
        </span>{" "}
        · {days}D
      </p>
    </div>
  );
}

function CurveHeatmap({
  heatmap, regimes,
}: {
  heatmap: AssetHeatmap;
  regimes: Record<string, RegimeMeta>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left text-neutral-500 uppercase tracking-wider pb-2 pr-4 font-normal">Asset</th>
            {HEATMAP_REGIMES.map((r) => (
              <th key={r} className="text-center pb-2 px-2 font-normal" style={{ color: REGIME_COLORS[r] }}>
                {regimes[r]?.label ?? r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {HEATMAP_ASSETS.map((asset) => (
            <tr key={asset} className="border-t border-neutral-800/50">
              <td className="py-2 pr-4 text-neutral-300 font-semibold">
                {HEATMAP_ASSET_LABELS[asset] ?? asset}
              </td>
              {HEATMAP_REGIMES.map((regime) => {
                const val = heatmap[asset]?.[regime] ?? null;
                return (
                  <td key={regime} className={`py-2 px-2 text-center rounded ${heatColor(val)}`}>
                    {fmtPct(val)}
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
export default function YieldCurvePage() {
  const [data, setData] = useState<YieldCurveSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<"roc" | "zscore">("roc");
  const [window, setWindow] = useState(21);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        method,
        window: window.toString(),
      });
      const res = await fetch(`/api/yield-curve/snapshot?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: YieldCurveSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load yield curve data");
    } finally {
      setLoading(false);
    }
  }, [method, window]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const currentColor = data ? REGIME_COLORS[data.current_regime] ?? "#6b7280" : "#6b7280";
  const currentLabel = data
    ? (data.regimes[data.current_regime]?.label ?? data.current_regime)
    : "—";
  const spreadNegative = data ? data.spread_bps < 0 : false;

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Yield Curve Regime</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            2s10s steepener / flattener / twist classification · FRED daily data
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
          <span className="text-neutral-500 uppercase tracking-wider">Window</span>
          {[5, 21, 63].map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 py-1 rounded transition-all ${
                window === w
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                  : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {w}D
            </button>
          ))}
        </div>
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

      {/* ── Inversion alert ── */}
      {data?.inverted && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Curve Inverted — 2Y yield exceeds 10Y. Historically precedes recession by 12–18 months.
        </div>
      )}

      {/* ── KPI Strip — 8 cards, 4+4 layout ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
        <KpiCard
          label="Current Regime (Nominal)"
          value={loading && !data ? "—" : currentLabel}
          color={currentColor}
        />
        <KpiCard
          label="2Y Yield"
          value={data ? `${data.yield_2y.toFixed(2)}%` : "—"}
        />
        <KpiCard
          label="10Y Yield"
          value={data ? `${data.yield_10y.toFixed(2)}%` : "—"}
        />
        <KpiCard
          label="Spread"
          value={data ? `${data.spread_bps >= 0 ? "+" : ""}${data.spread_bps.toFixed(0)} bps` : "—"}
          color={spreadNegative ? "#f87171" : undefined}
          sub={spreadNegative ? "inverted" : undefined}
        />
        <KpiCard
          label="Spread Δ"
          value={
            data
              ? `${data.spread_change_bps >= 0 ? "▲ +" : "▼ "}${data.spread_change_bps.toFixed(0)} bps`
              : "—"
          }
          color={data ? (data.spread_change_bps >= 0 ? "#34d399" : "#f87171") : undefined}
          sub={data ? `over ${data.window}d window` : undefined}
        />
        <KpiCard
          label="Days in Regime"
          value={data ? data.days_in_regime.toString() : "—"}
          sub="consecutive days"
        />
        <KpiCard
          label="Real Regime"
          value={data ? (data.regimes[data.real_regime]?.label ?? data.real_regime) : "—"}
          color={data ? REGIME_COLORS[data.real_regime] ?? "#6b7280" : undefined}
          sub={data ? `5s10s TIPS · ${data.real_days_in_regime}d` : undefined}
        />
        <KpiCard
          label="Inflation Regime"
          value={data ? (data.regimes[data.inflation_regime]?.label ?? data.inflation_regime) : "—"}
          color={data ? REGIME_COLORS[data.inflation_regime] ?? "#6b7280" : undefined}
          sub={data ? `5s10s breakeven · ${data.inflation_days_in_regime}d` : undefined}
        />
      </div>

      {/* ── Three-curve regime banner ── */}
      {data && <ThreeCurveBanner data={data} />}

      {/* ── Regime grid + charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* Regime 2×3 grid */}
        <div className="lg:col-span-2 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-3.5 h-3.5 text-neutral-500" />
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500">
              Curve Regimes — Current State
            </span>
          </div>
          {data ? (
            <RegimeGrid current={data.current_regime} regimes={data.regimes} />
          ) : (
            <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading regime data..." : "No data"}
            </div>
          )}
        </div>

        {/* Yield + spread charts */}
        <div className="lg:col-span-3 space-y-5">
          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
              2Y vs 10Y Treasury Yield — Regime Shading
            </span>
            {data?.time_series?.length ? (
              <YieldChart ts={data.time_series} regimes={data.regimes} />
            ) : (
              <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Loading yields..." : "No data"}
              </div>
            )}
          </div>

          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
              2s10s Spread (bps) — Green Above Zero · Red Inverted
            </span>
            {data?.time_series?.length ? (
              <SpreadChart ts={data.time_series} regimes={data.regimes} />
            ) : (
              <div className="h-48 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Loading spread..." : "No data"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Real 5s10s spread ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase block" style={{ color: "#38bdf8" }}>
            Real 5s10s Spread
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            TIPS REAL YIELD · 10Y MINUS 5Y · BP · REGIME SHADING · (NO 2Y TIPS ON FRED)
          </span>
          {data?.real_time_series?.length ? (
            <DecompSpreadChart
              ts={data.real_time_series}
              regimes={data.regimes}
              posColor="#38bdf8"
              gradientId="realSpread"
              name="Real 5s10s"
            />
          ) : (
            <div className="h-44 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading real spread..." : "No data"}
            </div>
          )}
        </div>
        <div className="flex flex-col justify-center">
          {data && (
            <DecompMiniPanel
              title="REAL 5S10S"
              spread={data.real_spread_bps}
              change={data.real_spread_change_bps}
              window={data.window}
              regime={data.real_regime}
              days={data.real_days_in_regime}
              regimes={data.regimes}
              accent="#38bdf8"
            />
          )}
        </div>
      </div>

      {/* ── Inflation 5s10s spread ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase block" style={{ color: "#fb923c" }}>
            Inflation Swap 5s10s Spread
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            BREAKEVEN · 10Y MINUS 5Y · BP · REGIME SHADING
          </span>
          {data?.inflation_time_series?.length ? (
            <DecompSpreadChart
              ts={data.inflation_time_series}
              regimes={data.regimes}
              posColor="#fb923c"
              gradientId="infSpread"
              name="Inf 5s10s"
            />
          ) : (
            <div className="h-44 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading inflation spread..." : "No data"}
            </div>
          )}
        </div>
        <div className="flex flex-col justify-center">
          {data && (
            <DecompMiniPanel
              title="INF 5S10S"
              spread={data.inflation_spread_bps}
              change={data.inflation_spread_change_bps}
              window={data.window}
              regime={data.inflation_regime}
              days={data.inflation_days_in_regime}
              regimes={data.regimes}
              accent="#fb923c"
            />
          )}
        </div>
      </div>

      {/* ── Asset Heatmap ── */}
      <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
          Asset Returns by Curve Regime — Avg Monthly Return (%)
        </span>
        {data?.asset_heatmap ? (
          <CurveHeatmap heatmap={data.asset_heatmap} regimes={data.regimes} />
        ) : (
          <div className="h-40 flex items-center justify-center text-neutral-600 text-sm">
            {loading ? "Computing asset returns..." : "No data"}
          </div>
        )}
      </div>

    </div>
  );
}
