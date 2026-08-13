"use client";

/**
 * Rate Decomposition — app/rate-decomp/page.tsx
 *
 * Nominal = real + inflation swap — an exact identity, not a model fit.
 * Tenors: 5Y/7Y/10Y/30Y (FRED has no 2Y TIPS yield). Curve decomp: 5s30s.
 * API: GET /api/rate-decomp/snapshot?lookback=1y&roll_window=10
 */

import { useEffect, useState, useCallback } from "react";
import {
  ComposedChart, LineChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, ScatterChart, Scatter,
} from "recharts";
import { RefreshCw, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TenorSnapshot {
  nominal: number;
  real: number;
  inflation_swap: number;
  nominal_1m_chg: number;
  real_1m_chg: number;
  inflation_1m_chg: number;
  driver_1m: string;
  driver_1m_pct: number | null;
}

interface CurveComplex {
  tenors: string[];
  nominal_today: number[];
  nominal_1m_ago: number[];
  real_today: number[];
  real_1m_ago: number[];
  inflation_today: number[];
  inflation_1m_ago: number[];
}

interface AttributionRow {
  date: string;
  nominal_chg: number;
  real_chg: number;
  inflation_chg: number;
}

interface SpreadRow {
  date: string;
  nominal_chg: number;
  real_leg: number;
  inflation_leg: number;
}

interface CurveDecomp {
  short_tenor: string;
  long_tenor: string;
  nominal_spread: number;
  real_spread: number;
  inflation_spread: number;
  nominal_1m_chg: number;
  real_leg_1m_chg: number;
  inflation_leg_1m_chg: number;
  driver: string;
  driver_pct: number | null;
  time_series: SpreadRow[];
}

interface QuadrantPoint {
  date: string;
  real_leg_21d: number;
  inf_leg_21d: number;
}

interface Quadrant {
  current: { real_leg_21d: number; inf_leg_21d: number; label: string } | null;
  trail: QuadrantPoint[];
}

interface RateDecompSnapshot {
  as_of: string;
  tenor_note: string;
  tenors: Record<string, TenorSnapshot>;
  headline: TenorSnapshot & { tenor: string };
  curve_complex: CurveComplex;
  attribution_short: AttributionRow[];
  attribution_10y: AttributionRow[];
  curve_decomp: CurveDecomp;
  quadrant: Quadrant;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const WHITE = "#F0F0F0";
const BLUE = "#38bdf8";     // real component — consistent across dashboard
const ORANGE = "#fb923c";   // inflation component
const GREEN = "#34d399";
const RED = "#f87171";
const MUTED = "#6b7280";
const AMBER = "#f59e0b";

const TENOR_ORDER = ["5Y", "7Y", "10Y", "30Y"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBp(v: number | null, dp = 0): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}bp`;
}

function chgColor(v: number): string {
  return v >= 0 ? GREEN : RED;
}

function driverColor(driver: string): string {
  if (driver === "REAL") return BLUE;
  if (driver === "INFLATION") return ORANGE;
  return MUTED;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Symmetric bar-chart domain so zero sits in the middle
function symDomain(values: number[]): [number, number] {
  const m = Math.max(1, ...values.map((v) => Math.abs(v)));
  const pad = Math.ceil(m * 1.1);
  return [-pad, pad];
}

// ── Info panels ───────────────────────────────────────────────────────────────
function InfoPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-md p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <p className="text-[10px] font-mono tracking-widest uppercase mb-2" style={{ color: AMBER }}>
        {title}
      </p>
      <div className="text-[11px] leading-relaxed text-neutral-400 font-mono space-y-1">
        {children}
      </div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, valueColor, subColor,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  valueColor?: string;
  subColor?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">{label}</span>
      <span className="text-xl font-semibold font-mono tabular-nums" style={{ color: valueColor ?? WHITE }}>
        {value}
      </span>
      {sub && (
        <span className="text-[11px] font-mono" style={{ color: subColor ?? "#6b7280" }}>{sub}</span>
      )}
    </div>
  );
}

// ── Curve complex mini chart ──────────────────────────────────────────────────
function CurveMini({
  title, color, today, ago, tenors, changes,
}: {
  title: string;
  color: string;
  today: number[];
  ago: number[];
  tenors: string[];
  changes: number[];
}) {
  const data = tenors.map((t, i) => ({ tenor: t, today: today[i], ago: ago[i] }));
  const all = [...today, ...ago];
  const yMin = Math.floor(Math.min(...all) * 10) / 10 - 0.05;
  const yMax = Math.ceil(Math.max(...all) * 10) / 10 + 0.05;

  return (
    <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] font-mono tracking-widest uppercase" style={{ color }}>
          {title}
        </span>
        <span className="text-[9px] font-mono tracking-wider text-neutral-600">
          TODAY <span className="text-neutral-700">— · —</span> 1M AGO
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-2 text-[10px] font-mono">
        {tenors.map((t, i) => (
          <span key={t} className="text-neutral-400">
            {t} {today[i]?.toFixed(2)}%{" "}
            <span style={{ color: chgColor(changes[i]) }}>{fmtBp(changes[i])}</span>
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="tenor"
            tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fill: "#6b7280", fontSize: 9, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => v.toFixed(1)}
            width={38}
          />
          <Tooltip
            contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
            itemStyle={{ fontFamily: "monospace" }}
            formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name === "today" ? "Today" : "1M ago"]}
          />
          <Line type="monotone" dataKey="today" stroke={color} strokeWidth={1.8} dot={{ r: 3, fill: color }} />
          <Line type="monotone" dataKey="ago" stroke="#4b5563" strokeWidth={1.2} strokeDasharray="5 3" dot={{ r: 2.5, fill: "#4b5563" }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Tenor decomposition card ──────────────────────────────────────────────────
function TenorCard({ tenor, d }: { tenor: string; d: TenorSnapshot }) {
  return (
    <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-4 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold font-mono text-neutral-200">{tenor}</span>
        <span className="text-[10px] font-mono" style={{ color: chgColor(d.nominal_1m_chg) }}>
          1M {fmtBp(d.nominal_1m_chg)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center">
        {([
          ["NOM", d.nominal, WHITE],
          ["REAL", d.real, BLUE],
          ["INF", d.inflation_swap, ORANGE],
        ] as const).map(([lab, val, col]) => (
          <div key={lab}>
            <p className="text-[9px] font-mono tracking-widest text-neutral-600">{lab}</p>
            <p className="text-sm font-mono tabular-nums" style={{ color: col }}>{val.toFixed(2)}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] font-mono tracking-wider text-neutral-600 pt-1 border-t border-neutral-800">
        1M DRIVER ·{" "}
        <span style={{ color: driverColor(d.driver_1m) }}>
          {d.driver_1m}
          {d.driver_1m_pct !== null ? ` ${d.driver_1m_pct.toFixed(0)}%` : ""}
        </span>
      </p>
    </div>
  );
}

// ── Attribution chart (stacked bars + nominal line) ───────────────────────────
interface AttribDatum {
  date: string;
  real: number;
  inflation: number;
  nominal: number;
}

function AttributionChart({
  rows, height = 240,
}: {
  rows: AttribDatum[];
  height?: number;
}) {
  const domain = symDomain(rows.flatMap((r) => [r.nominal, r.real, r.inflation]));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis
          dataKey="date"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: string) => v.slice(0, 7)}
          interval="preserveStartEnd"
          minTickGap={50}
        />
        <YAxis
          domain={domain}
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          label={{ value: "bp", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          labelFormatter={(v: string) => fmtDate(v)}
          formatter={(v: number, name: string) => [fmtBp(v, 1), name]}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        <ReferenceLine y={0} stroke="#374151" />
        <Bar dataKey="real" stackId="a" fill={BLUE} name="REAL CONTRIBUTION" />
        <Bar dataKey="inflation" stackId="a" fill={ORANGE} name="INFLATION CONTRIBUTION" />
        <Line type="monotone" dataKey="nominal" stroke={WHITE} strokeWidth={1.2} dot={false} name="NOMINAL CHANGE" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Quadrant scatter ──────────────────────────────────────────────────────────
function QuadrantChart({ quadrant }: { quadrant: Quadrant }) {
  const trail = quadrant.trail.slice(0, -1);
  const current = quadrant.current;
  const all = quadrant.trail.flatMap((p) => [p.real_leg_21d, p.inf_leg_21d]);
  const m = Math.max(5, ...all.map((v) => Math.abs(v))) * 1.2;

  return (
    <div className="relative">
      {/* Quadrant labels */}
      <span className="absolute top-8 left-12 text-[9px] font-mono text-neutral-700 z-10">
        INF STEEPENS · REAL FLATTENS
      </span>
      <span className="absolute top-8 right-4 text-[9px] font-mono text-neutral-700 z-10">
        BOTH STEEPEN
      </span>
      <span className="absolute bottom-12 left-12 text-[9px] font-mono text-neutral-700 z-10">
        BOTH FLATTEN
      </span>
      <span className="absolute bottom-12 right-4 text-[9px] font-mono text-neutral-700 z-10">
        REAL STEEPENS · INF FLATTENS
      </span>
      <ResponsiveContainer width="100%" aspect={1.05}>
        <ScatterChart margin={{ top: 20, right: 20, left: -8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            type="number"
            dataKey="real_leg_21d"
            domain={[-m, m]}
            tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            label={{ value: "REAL LEG 21D BP", position: "insideBottom", offset: -2, fill: BLUE, fontSize: 9 }}
          />
          <YAxis
            type="number"
            dataKey="inf_leg_21d"
            domain={[-m, m]}
            tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            label={{ value: "INF LEG 21D BP", angle: -90, position: "insideLeft", fill: ORANGE, fontSize: 9 }}
          />
          <ReferenceLine x={0} stroke="#4b5563" strokeDasharray="4 4" />
          <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
            itemStyle={{ fontFamily: "monospace" }}
            formatter={(v: number, name: string) => [fmtBp(v, 1), name === "real_leg_21d" ? "Real leg" : "Inf leg"]}
            cursor={{ strokeDasharray: "3 3" }}
          />
          <Scatter data={trail} fill="#4b5563" opacity={0.55} shape="circle" />
          {current && (
            <Scatter
              data={[current]}
              fill={AMBER}
              stroke="#F0F0F0"
              strokeWidth={2}
              shape="circle"
            />
          )}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function RateDecompPage() {
  const [data, setData] = useState<RateDecompSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rollWindow, setRollWindow] = useState(10);
  const [lookback, setLookback] = useState("1y");
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ lookback, roll_window: rollWindow.toString() });
      const res = await fetch(`/api/rate-decomp/snapshot?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: RateDecompSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load rate decomposition");
    } finally {
      setLoading(false);
    }
  }, [lookback, rollWindow]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const h = data?.headline;
  const cd = data?.curve_decomp;
  const cc = data?.curve_complex;

  const shortRows: AttribDatum[] = (data?.attribution_short ?? []).map((r) => ({
    date: r.date, real: r.real_chg, inflation: r.inflation_chg, nominal: r.nominal_chg,
  }));
  const tenYRows: AttribDatum[] = (data?.attribution_10y ?? []).map((r) => ({
    date: r.date, real: r.real_chg, inflation: r.inflation_chg, nominal: r.nominal_chg,
  }));
  const spreadRows: AttribDatum[] = (cd?.time_series ?? []).map((r) => ({
    date: r.date, real: r.real_leg, inflation: r.inflation_leg, nominal: r.nominal_chg,
  }));

  const rollLabel = `${rollWindow}D`;
  const lookbackLabel = lookback.toUpperCase();
  const shortTenor = cd?.short_tenor ?? "5Y";
  const longTenor = cd?.long_tenor ?? "30Y";
  const spreadName = `${shortTenor.replace("Y", "")}S${longTenor.replace("Y", "")}S`; // 5S30S

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest text-neutral-600 uppercase">
              Rate Decomposition
            </span>
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">US · Rate Decomposition</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            Nominal = real + inflation swap · an exact identity, not a model fit · 5Y/7Y/10Y/30Y (no 2Y TIPS on FRED)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[11px] font-mono text-neutral-600 flex items-center gap-1 mr-2">
              <Clock className="w-3 h-3" /> {lastUpdated}
            </span>
          )}
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 text-xs text-neutral-400 hover:text-white transition-colors border border-neutral-700 rounded px-3 py-1.5 hover:border-neutral-500 disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-neutral-900/60 rounded-lg border border-neutral-800 text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 uppercase tracking-wider">Roll Window</span>
          {[5, 10, 21].map((w) => (
            <button
              key={w}
              onClick={() => setRollWindow(w)}
              className={`px-2 py-1 rounded transition-all ${
                rollWindow === w
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                  : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {w}D
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 uppercase tracking-wider">Lookback</span>
          {["3m", "6m", "1y", "2y"].map((l) => (
            <button
              key={l}
              onClick={() => setLookback(l)}
              className={`px-2 py-1 rounded uppercase transition-all ${
                lookback === l
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                  : "text-neutral-500 border border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
        <KpiCard
          label="10Y Nominal"
          value={h ? `${h.nominal.toFixed(2)}%` : "—"}
          sub={h ? `1M ${fmtBp(h.nominal_1m_chg)}` : undefined}
          subColor={h ? chgColor(h.nominal_1m_chg) : undefined}
        />
        <KpiCard
          label="10Y Real"
          value={h ? `${h.real.toFixed(2)}%` : "—"}
          valueColor={BLUE}
          sub={h ? `1M ${fmtBp(h.real_1m_chg)}` : undefined}
          subColor={h ? chgColor(h.real_1m_chg) : undefined}
        />
        <KpiCard
          label="10Y Inflation Swap"
          value={h ? `${h.inflation_swap.toFixed(2)}%` : "—"}
          valueColor={ORANGE}
          sub={h ? `1M ${fmtBp(h.inflation_1m_chg)}` : undefined}
          subColor={h ? chgColor(h.inflation_1m_chg) : undefined}
        />
        <KpiCard
          label="10Y Driver · 1M"
          value={
            h ? (
              <span>
                <span style={{ color: driverColor(h.driver_1m) }}>{h.driver_1m}</span>
                {h.driver_1m_pct !== null && (
                  <span className="text-neutral-400 text-sm"> {h.driver_1m_pct.toFixed(0)}% OF MOVE</span>
                )}
              </span>
            ) : "—"
          }
        />
      </div>

      {/* ── Curve Complex ── */}
      {cc && data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <CurveMini
            title="Nominal"
            color={WHITE}
            today={cc.nominal_today}
            ago={cc.nominal_1m_ago}
            tenors={cc.tenors}
            changes={cc.tenors.map((t) => data.tenors[t]?.nominal_1m_chg ?? 0)}
          />
          <CurveMini
            title="Real"
            color={BLUE}
            today={cc.real_today}
            ago={cc.real_1m_ago}
            tenors={cc.tenors}
            changes={cc.tenors.map((t) => data.tenors[t]?.real_1m_chg ?? 0)}
          />
          <CurveMini
            title="Inflation Swap"
            color={ORANGE}
            today={cc.inflation_today}
            ago={cc.inflation_1m_ago}
            tenors={cc.tenors}
            changes={cc.tenors.map((t) => data.tenors[t]?.inflation_1m_chg ?? 0)}
          />
        </div>
      )}

      {/* ── Per-tenor decomposition strip ── */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          {TENOR_ORDER.filter((t) => data.tenors[t]).map((t) => (
            <TenorCard key={t} tenor={t} d={data.tenors[t]} />
          ))}
        </div>
      )}

      {/* ── Short-tenor rolling attribution ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            {shortTenor} Rolling Attribution
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            {shortTenor} · ROLLING {rollLabel} CHANGE IN BP · REAL + INFLATION CONTRIBUTIONS · {lookbackLabel} · DAILY
          </span>
          {shortRows.length ? (
            <AttributionChart rows={shortRows} />
          ) : (
            <div className="h-56 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
        <div className="space-y-5">
          <InfoPanel title="What This Is">
            <p>
              A nominal treasury yield is the sum of a real yield and an inflation swap, so every
              basis point of a nominal move can be assigned exactly to one of the two legs. Each bar
              splits the trailing {rollLabel.toLowerCase()} nominal change into its real and
              inflation contributions; the white line is the nominal change the two legs sum to.
            </p>
          </InfoPanel>
          {data && (
            <InfoPanel title="Current Reading">
              <p>{shortTenor} 1M {fmtBp(data.tenors[shortTenor]?.nominal_1m_chg ?? 0)} nominal</p>
              <p>
                real{" "}
                <span style={{ color: BLUE }}>{fmtBp(data.tenors[shortTenor]?.real_1m_chg ?? 0)}</span>
                {" · "}inf{" "}
                <span style={{ color: ORANGE }}>{fmtBp(data.tenors[shortTenor]?.inflation_1m_chg ?? 0)}</span>
                {" · "}
                <span style={{ color: driverColor(data.tenors[shortTenor]?.driver_1m ?? "") }}>
                  {data.tenors[shortTenor]?.driver_1m}{" "}
                  {data.tenors[shortTenor]?.driver_1m_pct?.toFixed(0) ?? ""}%
                </span>
              </p>
            </InfoPanel>
          )}
        </div>
      </div>

      {/* ── 10Y rolling attribution ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            10Y Rolling Attribution
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            10Y · ROLLING {rollLabel} CHANGE IN BP · REAL + INFLATION CONTRIBUTIONS · {lookbackLabel} · DAILY
          </span>
          {tenYRows.length ? (
            <AttributionChart rows={tenYRows} />
          ) : (
            <div className="h-56 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
        <div>
          {h && (
            <InfoPanel title="Current Reading">
              <p>10Y 1M {fmtBp(h.nominal_1m_chg)} nominal</p>
              <p>
                real <span style={{ color: BLUE }}>{fmtBp(h.real_1m_chg)}</span>
                {" · "}inf <span style={{ color: ORANGE }}>{fmtBp(h.inflation_1m_chg)}</span>
                {" · "}
                <span style={{ color: driverColor(h.driver_1m) }}>
                  {h.driver_1m} {h.driver_1m_pct?.toFixed(0) ?? ""}%
                </span>
              </p>
            </InfoPanel>
          )}
        </div>
      </div>

      {/* ── Curve decomposition + quadrant ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            {spreadName} Rolling Attribution
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            {spreadName} = {longTenor} MINUS {shortTenor} · ROLLING {rollLabel} CHANGE IN BP · REAL + INFLATION LEGS · {lookbackLabel} · DAILY
          </span>
          {spreadRows.length ? (
            <AttributionChart rows={spreadRows} height={230} />
          ) : (
            <div className="h-56 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
          {cd && data?.quadrant.current && (
            <div className="mt-4">
              <InfoPanel title="Current Reading">
                <p>
                  {spreadName.toLowerCase()} {cd.nominal_spread.toFixed(0)}bp · 1M {fmtBp(cd.nominal_1m_chg)}
                </p>
                <p>
                  real leg <span style={{ color: BLUE }}>{fmtBp(data.quadrant.current.real_leg_21d)}</span> 21d
                  {" · "}inflation leg{" "}
                  <span style={{ color: ORANGE }}>{fmtBp(data.quadrant.current.inf_leg_21d)}</span> 21d
                </p>
                <p>quadrant · <span className="text-neutral-300">{data.quadrant.current.label}</span></p>
                <p>
                  driver ·{" "}
                  <span style={{ color: driverColor(cd.driver) }}>
                    {cd.driver} {cd.driver_pct?.toFixed(0) ?? ""}%
                  </span>
                </p>
              </InfoPanel>
            </div>
          )}
        </div>
        <div className="lg:col-span-2 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            Curve Leg Quadrant
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-2">
            21D LEG CHANGES · TRAIL 60 SESSIONS · RING = TODAY
          </span>
          {data?.quadrant.trail.length ? (
            <QuadrantChart quadrant={data.quadrant} />
          ) : (
            <div className="aspect-square flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
