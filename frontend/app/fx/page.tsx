"use client";

/**
 * FX · Rate Differential Models — app/fx/page.tsx
 *
 * EURUSD / USDJPY / GBPUSD vs their 2Y(5Y) and 10Y rate differentials, with
 * rolling OLS return attribution. One snapshot call; pair tabs are client-side.
 * API: GET /api/fx/snapshot?ols_lookback=20&ret_window=20
 */

import { useEffect, useState, useCallback } from "react";
import {
  ComposedChart, LineChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { RefreshCw, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AttrRow {
  date: string;
  actual_20d: number;
  explained: number;
  residual: number;
}

interface DecompRow {
  date: string;
  real_diff: number;
  inf_diff: number;
  nom_diff: number;
}

interface Decomposition {
  real_leg_tenor: string;
  real_source: string;
  real_diff_10y_bp: number;
  real_diff_1m_chg: number | null;
  inf_diff_10y_bp: number;
  inf_diff_1m_chg: number | null;
  driver_leg_1m: string | null;
  driver_leg_pct: number | null;
  real_series: DecompRow[];
}

interface PairData {
  spot: number;
  spot_1m_pct: number | null;
  convention: string;
  short_tenor: string;
  diff_2y_bp: number;
  diff_2y_1m_chg: number | null;
  diff_10y_bp: number;
  diff_10y_1m_chg: number | null;
  attribution_2y: AttrRow[];
  attribution_10y: AttrRow[];
  current: {
    driver_tenor: string | null;
    explained_share_2y: number | null;
    explained_share_10y: number | null;
    beta_2y: number | null;
    beta_10y: number | null;
  };
  decomposition: Decomposition | null;
}

interface SpotRow {
  date: string;
  spot: number;
  diff_2y: number | null;
  diff_10y: number | null;
}

interface FxSnapshot {
  as_of: string;
  ols_lookback: number;
  ret_window: number;
  failed_pairs: string[];
  pairs: Record<string, PairData>;
  spot_series: Record<string, SpotRow[]>;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const PAIR_ORDER = ["EURUSD", "USDJPY", "GBPUSD"];

const WHITE = "#F0F0F0";
const BLUE = "#38bdf8";
const ORANGE = "#fb923c";
const GREEN = "#34d399";
const RED = "#f87171";
const GRAY = "#6b7280";
const AMBER = "#f59e0b";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBp(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}bp`;
}

function chgColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return GRAY;
  return v >= 0 ? GREEN : RED;
}

function spotFmt(pair: string, v: number): string {
  return pair === "USDJPY" ? v.toFixed(2) : v.toFixed(4);
}

// ── Info panel ────────────────────────────────────────────────────────────────
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

// ── Spot vs differential dual-axis chart ─────────────────────────────────────
function DiffSpotChart({
  rows, pair, diffKey, diffColor, diffName,
}: {
  rows: SpotRow[];
  pair: string;
  diffKey: "diff_2y" | "diff_10y";
  diffColor: string;
  diffName: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
          yAxisId="spot"
          domain={["auto", "auto"]}
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => spotFmt(pair, v)}
          width={54}
        />
        <YAxis
          yAxisId="diff"
          orientation="right"
          domain={["auto", "auto"]}
          tick={{ fill: diffColor, fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v.toFixed(0)}`}
          width={44}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) =>
            name === "Spot" ? [spotFmt(pair, v), name] : [fmtBp(v), name]
          }
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        <Line yAxisId="spot" type="monotone" dataKey="spot" stroke={WHITE} strokeWidth={1.5} dot={false} name="Spot" />
        <Line yAxisId="diff" type="monotone" dataKey={diffKey} stroke={diffColor} strokeWidth={1.3} dot={false} name={diffName} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Attribution chart (stacked bars + actual line) ────────────────────────────
function AttributionChart({ rows }: { rows: AttrRow[] }) {
  const values = rows.flatMap((r) => [r.actual_20d, r.explained, r.residual]);
  const m = Math.ceil(Math.max(1, ...values.map((v) => Math.abs(v))) * 1.1);

  return (
    <ResponsiveContainer width="100%" height={210}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
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
          domain={[-m, m]}
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          label={{ value: "%", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        <ReferenceLine y={0} stroke="#374151" />
        <Bar dataKey="explained" stackId="a" fill={BLUE} name="EXPLAINED" />
        <Bar dataKey="residual" stackId="a" fill={GRAY} name="RESIDUAL" />
        <Line type="monotone" dataKey="actual_20d" stroke={WHITE} strokeWidth={1.2} dot={false} name="ACTUAL 20D" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── GBPUSD decomposition chart ───────────────────────────────────────────────
function DecompChart({ rows }: { rows: DecompRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={rows} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
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
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          label={{ value: "bp", angle: -90, position: "insideLeft", fill: "#4b5563", fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [fmtBp(v), name]}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="nom_diff" stroke={WHITE} strokeWidth={1.5} dot={false} name="NOMINAL" />
        <Line type="monotone" dataKey="real_diff" stroke={BLUE} strokeWidth={1.3} dot={false} name="REAL" />
        <Line type="monotone" dataKey="inf_diff" stroke={ORANGE} strokeWidth={1.3} dot={false} name="INFLATION" />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FxPage() {
  const [data, setData] = useState<FxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pair, setPair] = useState("EURUSD");
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fx/snapshot?ols_lookback=20&ret_window=20");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: FxSnapshot = await res.json();
      setData(json);
      // If the selected pair failed, fall back to the first available
      if (!json.pairs[pair]) {
        const first = PAIR_ORDER.find((p) => json.pairs[p]);
        if (first) setPair(first);
      }
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load FX data");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const p = data?.pairs[pair];
  const rows = data?.spot_series[pair] ?? [];
  const shortLabel = p?.short_tenor ?? "2Y";
  const d = p?.decomposition;

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest text-neutral-600 uppercase">FX</span>
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">FX · Rate Differential Models</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            Spot vs short-tenor and 10Y differentials · rolling OLS return attribution
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

      {/* ── Errors / degraded ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}
      {data && data.failed_pairs.length > 0 && (
        <div className="p-3 rounded-lg bg-neutral-900/60 border border-neutral-800 text-neutral-500 text-[11px] font-mono">
          {data.failed_pairs.join(", ")} unavailable · yield leg fetch failed
        </div>
      )}

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
        {PAIR_ORDER.filter((name) => data?.pairs[name]).map((name) => {
          const pd = data!.pairs[name];
          return (
            <div key={name} className="flex flex-col gap-1 px-5 py-4">
              <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">{name}</span>
              <span className="text-xl font-semibold font-mono tabular-nums text-[#F0F0F0]">
                {spotFmt(name, pd.spot)}
              </span>
              <span className="text-[11px] font-mono" style={{ color: chgColor(pd.spot_1m_pct) }}>
                1M {pd.spot_1m_pct !== null ? `${pd.spot_1m_pct >= 0 ? "+" : ""}${pd.spot_1m_pct.toFixed(2)}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Pair tabs ── */}
      <div className="flex items-center gap-2 text-xs font-mono">
        {PAIR_ORDER.map((name) => (
          <button
            key={name}
            onClick={() => setPair(name)}
            disabled={!data?.pairs[name]}
            className={`px-4 py-1.5 rounded uppercase tracking-wider border transition-all disabled:opacity-30 ${
              pair === name
                ? "bg-amber-500/20 text-amber-400 border-amber-500/40"
                : "text-neutral-500 border-neutral-700 hover:border-neutral-500"
            }`}
          >
            {name}
          </button>
        ))}
        {p && (
          <span className="ml-auto text-[10px] text-neutral-600 uppercase tracking-wider">
            {p.convention}
            {shortLabel !== "2Y" && ` · short tenor ${shortLabel} (no UK 2Y series)`}
          </span>
        )}
      </div>

      {/* ── Differential vs spot charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            {shortLabel} Differential vs Spot
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            {p?.convention.toUpperCase()} · {shortLabel} · EACH LINE ON ITS OWN SCALE · 2Y LOOKBACK
          </span>
          {rows.length ? (
            <DiffSpotChart rows={rows} pair={pair} diffKey="diff_2y" diffColor={BLUE} diffName={`${shortLabel} Diff (bp)`} />
          ) : (
            <div className="h-52 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
        <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            10Y Differential vs Spot
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            {p?.convention.toUpperCase()} · 10Y · EACH LINE ON ITS OWN SCALE · 2Y LOOKBACK
          </span>
          {rows.length ? (
            <DiffSpotChart rows={rows} pair={pair} diffKey="diff_10y" diffColor={ORANGE} diffName="10Y Diff (bp)" />
          ) : (
            <div className="h-52 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
      </div>

      {/* ── Attribution charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {([
          [`${shortLabel} Attribution`, p?.attribution_2y ?? []],
          ["10Y Attribution", p?.attribution_10y ?? []],
        ] as const).map(([title, attrRows]) => (
          <div key={title} className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
              {title}
            </span>
            <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
              ROLLING {data?.ret_window ?? 20}D RETURNS · UNIVARIATE OLS LOOKBACK {data?.ols_lookback ?? 20}D · COMPONENTS NET TO THE LINE
            </span>
            {attrRows.length ? (
              <AttributionChart rows={attrRows} />
            ) : (
              <div className="h-52 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Loading..." : "No data"}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Decomposition + panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            10Y Differential Decomposition{d ? ` · ${p?.convention.toUpperCase()}` : ""}
          </span>
          {d ? (
            <>
              <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-3">
                {d.real_source.toUpperCase()} · IDENTITY: NOMINAL = REAL + INFLATION
              </span>
              <div className="flex flex-wrap gap-2 mb-3 text-[10px] font-mono tracking-wider">
                <span className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-300">
                  NOM {fmtBp(p!.diff_10y_bp)}
                </span>
                <span className="px-2 py-0.5 rounded border border-neutral-800" style={{ color: BLUE }}>
                  REAL {fmtBp(d.real_diff_10y_bp)}
                </span>
                <span className="px-2 py-0.5 rounded border border-neutral-800" style={{ color: ORANGE }}>
                  INF {fmtBp(d.inf_diff_10y_bp)}
                </span>
                {d.driver_leg_1m && (
                  <span className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-400">
                    1M DRIVER:{" "}
                    <span style={{ color: d.driver_leg_1m === "REAL" ? BLUE : ORANGE }}>
                      {d.driver_leg_1m} {d.driver_leg_pct}%
                    </span>
                  </span>
                )}
              </div>
              <DecompChart rows={d.real_series} />
            </>
          ) : (
            <div className="h-40 flex items-center justify-center text-center text-[11px] font-mono tracking-wider text-neutral-600 uppercase">
              Real/Inflation split unavailable
              <br />
              No free daily real yield source for DE/JP · Nominal only
            </div>
          )}
        </div>

        <div className="space-y-5">
          <InfoPanel title="What This Is">
            <p>
              Each pair is shown against its rate anchors at both ends of the curve. The stacked
              bars decompose the pair&apos;s rolling 20-day returns onto 20-day differential changes
              through a rolling univariate OLS; the residual closes the gap so components net
              exactly to the return line. When the residual dominates, the pair is trading on
              something other than rates.
            </p>
          </InfoPanel>
          {p && (
            <InfoPanel title="Current Reading">
              <p>
                {pair} <span className="text-neutral-200">{spotFmt(pair, p.spot)}</span>
                {" · 1M "}
                <span style={{ color: chgColor(p.spot_1m_pct) }}>
                  {p.spot_1m_pct !== null ? `${p.spot_1m_pct >= 0 ? "+" : ""}${p.spot_1m_pct.toFixed(2)}%` : "—"}
                </span>
              </p>
              <p>
                {shortLabel.toLowerCase()} diff{" "}
                <span style={{ color: BLUE }}>{fmtBp(p.diff_2y_bp)}</span>
                <span className="text-neutral-500"> (1m {fmtBp(p.diff_2y_1m_chg)})</span>
              </p>
              <p>
                10y diff <span style={{ color: ORANGE }}>{fmtBp(p.diff_10y_bp)}</span>
                <span className="text-neutral-500"> (1m {fmtBp(p.diff_10y_1m_chg)})</span>
              </p>
              <p>
                driver tenor ·{" "}
                <span className="text-neutral-200">{p.current.driver_tenor ?? "—"}</span>
                <span className="text-neutral-500">
                  {" "}(expl {p.current.explained_share_2y ?? "—"}% / {p.current.explained_share_10y ?? "—"}%)
                </span>
              </p>
              <p>
                betas · {shortLabel.toLowerCase()}{" "}
                <span className="text-neutral-200">{p.current.beta_2y ?? "—"}</span>
                {" · "}10y <span className="text-neutral-200">{p.current.beta_10y ?? "—"}</span>
              </p>
            </InfoPanel>
          )}
        </div>
      </div>

    </div>
  );
}
