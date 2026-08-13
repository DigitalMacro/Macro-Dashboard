"use client";

/**
 * Cross-Asset Regimes — app/cross-asset/page.tsx
 *
 * 8 directional regimes from vol-scaled SPX / UST 10Y / DXY signals, with BTC
 * overlaid as a fourth signal. Regime ribbon rendered inside the signal chart
 * as ReferenceArea bands pinned to the bottom of the y-domain.
 * API: GET /api/cross-asset/snapshot?lookback=20&vol_window=21
 */

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import { RefreshCw, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface SignalPoint {
  date: string;
  spx: number | null;
  rates: number | null;
  dxy: number | null;
  btc: number | null;
  regime: string;
}

interface CorrPoint {
  date: string;
  spx_rates: number | null;
  spx_dxy: number | null;
  rates_dxy: number | null;
  btc_spx: number | null;
  btc_rates: number | null;
  btc_dxy: number | null;
  avg_abs_core: number | null;
}

interface RegimeStat {
  regime: string;
  label: string;
  days: number;
  share: number;
  avg_run: number;
  btc_avg_daily_ret: number | null;
  btc_hit_rate: number | null;
  spx_avg_daily_ret: number | null;
}

interface CrossAssetSnapshot {
  as_of: string;
  sources: Record<string, string>;
  lookback: number;
  vol_window: number;
  current: {
    regime: string;
    regime_label: string;
    days_in_regime: number;
    signals: { spx: number; rates: number; dxy: number; btc: number };
    btc_state: string;
    btc_aligned_with_spx: boolean;
    levels: {
      spx: number; spx_1m_pct: number | null;
      ust10y: number; ust10y_1m_bp: number | null;
      dxy: number; dxy_1m_pct: number | null;
      btc: number; btc_1m_pct: number | null;
    };
  };
  signal_series: SignalPoint[];
  correlations: {
    series: CorrPoint[];
    current: Record<string, number>;
  };
  linkage: {
    series: { date: string; pc1_share: number }[];
    current_pc1_share: number | null;
    percentile_2y: number | null;
    with_btc_pc1_share: number | null;
    btc_in_complex: boolean | null;
  };
  regime_stats: RegimeStat[];
  most_frequent_2y: { regime: string; share: number };
  regimes: Record<string, { label: string; color: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const GREEN = "#34d399";
const BLUE = "#38bdf8";
const ORANGE = "#fb923c";
const PURPLE = "#c084fc";
const RED = "#f87171";
const AMBER = "#f59e0b";

const SIGNAL_COLORS: Record<string, string> = {
  spx: GREEN, rates: BLUE, dxy: ORANGE, btc: PURPLE,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtChg(v: number | null | undefined, unit: string, dp = 1): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}${unit}`;
}

function chgColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "#6b7280";
  return v >= 0 ? GREEN : RED;
}

function buildRegimeBands(ts: SignalPoint[]) {
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

// ── Signal chart with in-chart regime ribbon ──────────────────────────────────
function SignalChart({
  ts, regimes,
}: {
  ts: SignalPoint[];
  regimes: Record<string, { label: string; color: string }>;
}) {
  const bands = buildRegimeBands(ts);
  const values = ts.flatMap((p) =>
    [p.spx, p.rates, p.dxy, p.btc].filter((v): v is number => v !== null)
  );
  const m = Math.ceil(Math.max(1, ...values.map((v) => Math.abs(v))) * 1.1);
  const ribbonTop = -m + m * 0.12; // bottom ~6% of the [-m, m] domain

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={ts} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        {/* Regime ribbon: colored bands pinned to the bottom of the domain */}
        {bands.map((b, i) => (
          <ReferenceArea
            key={i}
            x1={b.start}
            x2={b.end}
            y1={-m}
            y2={ribbonTop}
            fill={regimes[b.regime]?.color ?? "#374151"}
            fillOpacity={0.9}
            strokeOpacity={0}
          />
        ))}
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
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [v.toFixed(2), name.toUpperCase()]}
        />
        <Legend
          wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }}
          formatter={(v: string) => v.toUpperCase()}
        />
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
        {(["spx", "rates", "dxy", "btc"] as const).map((k) => (
          <Line
            key={k}
            type="monotone"
            dataKey={k}
            stroke={SIGNAL_COLORS[k]}
            strokeWidth={k === "btc" ? 1.2 : 1.5}
            strokeDasharray={k === "btc" ? "4 2" : undefined}
            dot={false}
            name={k}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Simple line chart for correlations / covariance ───────────────────────────
function CorrChart({
  data, lines, domain, height = 200,
}: {
  data: CorrPoint[];
  lines: { key: keyof CorrPoint; color: string; name: string }[];
  domain: [number, number];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
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
          tickFormatter={(v: number) => v.toFixed(1)}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [v.toFixed(2), name]}
        />
        {lines.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        )}
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
        {lines.map((l) => (
          <Line
            key={String(l.key)}
            type="monotone"
            dataKey={l.key as string}
            stroke={l.color}
            strokeWidth={1.5}
            dot={false}
            name={l.name}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CrossAssetPage() {
  const [data, setData] = useState<CrossAssetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cross-asset/snapshot?lookback=20&vol_window=21");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: CrossAssetSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load cross-asset data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const c = data?.current;
  const lv = c?.levels;
  const regimeColor = data && c ? data.regimes[c.regime]?.color ?? "#6b7280" : "#6b7280";
  const corr = data?.correlations.current ?? {};
  const link = data?.linkage;

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest text-neutral-600 uppercase">
              Cross-Asset Regimes
            </span>
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Cross-Asset Regimes</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            SPX, UST 10Y and DXY vol-scaled signals classified into 8 directional regimes · BTC overlay
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

      {/* ── Error ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-neutral-800 rounded-lg overflow-hidden border border-neutral-800">
        {([
          ["SPX", lv ? lv.spx.toLocaleString() : "—", fmtChg(lv?.spx_1m_pct, "%"), lv?.spx_1m_pct],
          ["UST 10Y", lv ? `${lv.ust10y.toFixed(2)}%` : "—", fmtChg(lv?.ust10y_1m_bp, "bp", 0), lv?.ust10y_1m_bp],
          ["DXY", lv ? lv.dxy.toFixed(1) : "—", fmtChg(lv?.dxy_1m_pct, "%"), lv?.dxy_1m_pct],
          ["BTC", lv ? lv.btc.toLocaleString() : "—", fmtChg(lv?.btc_1m_pct, "%"), lv?.btc_1m_pct],
        ] as const).map(([label, value, chg, raw]) => (
          <div key={label} className="flex flex-col gap-1 px-5 py-4 bg-[#111116]">
            <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">{label}</span>
            <span className="text-xl font-semibold font-mono tabular-nums text-[#F0F0F0]">{value}</span>
            <span className="text-[11px] font-mono" style={{ color: chgColor(raw) }}>1M {chg}</span>
          </div>
        ))}
        <div
          className="flex flex-col gap-1 px-5 py-4 bg-[#111116]"
          style={{ borderLeft: `3px solid ${regimeColor}` }}
        >
          <span className="text-[10px] tracking-widest uppercase text-neutral-500 font-mono">Current Regime</span>
          <span className="text-xl font-semibold font-mono" style={{ color: regimeColor }}>
            {c?.regime ?? "—"}
          </span>
          <span className="text-[10px] font-mono text-neutral-500">{c?.regime_label}</span>
          {c && (
            <span
              className="text-[9px] font-mono tracking-wider mt-1 px-1.5 py-0.5 rounded border w-fit"
              style={{
                color: c.btc_aligned_with_spx ? GREEN : PURPLE,
                borderColor: "rgba(255,255,255,0.12)",
              }}
            >
              BTC {c.btc_state === "up" ? "UP" : "DN"} · {c.btc_aligned_with_spx ? "ALIGNED W/ SPX" : "DIVERGENT"}
            </span>
          )}
        </div>
      </div>

      {/* ── Signals + panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 space-y-5">
          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
              Vol-Scaled Directional Signals
            </span>
            <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
              US · VOL-SCALED · {data?.lookback ?? 20}D LOOKBACK · {data?.vol_window ?? 21}D VOL · 2Y · DAILY · RIBBON = REGIME
            </span>
            {data?.signal_series.length ? (
              <SignalChart ts={data.signal_series} regimes={data.regimes} />
            ) : (
              <div className="h-72 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Computing signals..." : "No data"}
              </div>
            )}
          </div>

          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
              Rolling Covariance
            </span>
            <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
              AVG ABS PAIRWISE CORRELATION · SPX % / UST 10Y BP / DXY % RAW DAILY MOVES · 20D ROLLING · 2Y
            </span>
            {data?.correlations.series.length ? (
              <CorrChart
                data={data.correlations.series}
                lines={[{ key: "avg_abs_core", color: PURPLE, name: "AVG |CORR|" }]}
                domain={[0, 1]}
              />
            ) : (
              <div className="h-48 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Loading..." : "No data"}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <InfoPanel title="What This Is">
            <p>
              Every day is sorted into one of 8 regimes by whether SPX, UST 10Y and DXY are moving
              up or down over the lookback window, with each move scaled by its own volatility so
              the assets are comparable. BTC is overlaid as a fourth signal: its direction, its
              correlation to each leg, and its average performance inside each regime — showing
              whether crypto is trading as a macro asset or on its own story.
            </p>
          </InfoPanel>
          {data && c && (
            <InfoPanel title="Current Reading">
              <p>
                regime · <span style={{ color: regimeColor }}>{c.regime}</span>{" "}
                <span className="text-neutral-500">{c.regime_label}</span> · {c.days_in_regime}d
              </p>
              <p>
                signals · spx <span style={{ color: GREEN }}>{c.signals.spx.toFixed(2)}</span>
                {" "}rates <span style={{ color: BLUE }}>{c.signals.rates.toFixed(2)}</span>
                {" "}dxy <span style={{ color: ORANGE }}>{c.signals.dxy.toFixed(2)}</span>
                {" "}btc <span style={{ color: PURPLE }}>{c.signals.btc.toFixed(2)}</span>
              </p>
              <p>
                most frequent 2y ·{" "}
                <span className="text-neutral-200">
                  {data.most_frequent_2y.regime} ({data.most_frequent_2y.share.toFixed(1)}%)
                </span>
              </p>
              <p>
                btc · {c.btc_state.toUpperCase()} ·{" "}
                {c.btc_aligned_with_spx ? "aligned with SPX" : "divergent from SPX"}
              </p>
            </InfoPanel>
          )}
        </div>
      </div>

      {/* ── BTC correlations ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            BTC · Macro Correlations
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            20D ROLLING CORRELATION OF RAW DAILY MOVES · 2Y
          </span>
          {data?.correlations.series.length ? (
            <CorrChart
              data={data.correlations.series}
              lines={[
                { key: "btc_spx", color: GREEN, name: "BTC/SPX" },
                { key: "btc_rates", color: BLUE, name: "BTC/RATES" },
                { key: "btc_dxy", color: ORANGE, name: "BTC/DXY" },
              ]}
              domain={[-1, 1]}
              height={220}
            />
          ) : (
            <div className="h-52 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
        </div>
        <div>
          {link && (
            <InfoPanel title="BTC Reading">
              <p>
                BTC/SPX <span style={{ color: GREEN }}>{corr.btc_spx?.toFixed(2) ?? "—"}</span>
                {" · "}BTC/RATES <span style={{ color: BLUE }}>{corr.btc_rates?.toFixed(2) ?? "—"}</span>
                {" · "}BTC/DXY <span style={{ color: ORANGE }}>{corr.btc_dxy?.toFixed(2) ?? "—"}</span>
              </p>
              <p>
                linkage (3-asset) ·{" "}
                <span className="text-neutral-200">
                  {link.current_pc1_share !== null ? `${(link.current_pc1_share * 100).toFixed(1)}%` : "—"}
                </span>
                {link.percentile_2y !== null && (
                  <span className="text-neutral-500"> · 2y %ile {link.percentile_2y}</span>
                )}
              </p>
              <p>
                linkage +btc ·{" "}
                <span className="text-neutral-200">
                  {link.with_btc_pc1_share !== null ? `${(link.with_btc_pc1_share * 100).toFixed(1)}%` : "—"}
                </span>
              </p>
              {link.btc_in_complex !== null && (
                <p className="pt-1" style={{ color: link.btc_in_complex ? GREEN : PURPLE }}>
                  {link.btc_in_complex
                    ? "BTC TRADING WITH THE MACRO COMPLEX"
                    : "BTC ON ITS OWN STORY"}
                </p>
              )}
            </InfoPanel>
          )}
        </div>
      </div>

      {/* ── Regime frequency table ── */}
      <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
          Regime Frequency
        </span>
        <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
          2Y WINDOW · TRADING DAYS · SHARE · AVG RUN · BTC PERFORMANCE
        </span>
        {data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-neutral-500 uppercase tracking-wider text-[10px]">
                  <th className="text-left pb-2 pr-4 font-normal">Regime</th>
                  <th className="text-right pb-2 px-2 font-normal">Days</th>
                  <th className="text-left pb-2 px-2 font-normal w-40">Share</th>
                  <th className="text-right pb-2 px-2 font-normal">Avg Run</th>
                  <th className="text-right pb-2 px-2 font-normal">BTC Avg</th>
                  <th className="text-right pb-2 px-2 font-normal">BTC Hit</th>
                  <th className="text-right pb-2 px-2 font-normal">SPX Avg</th>
                </tr>
              </thead>
              <tbody>
                {data.regime_stats.map((r) => {
                  const isNow = r.regime === data.current.regime;
                  const color = data.regimes[r.regime]?.color ?? "#6b7280";
                  return (
                    <tr
                      key={r.regime}
                      className="border-t border-neutral-800/50"
                      style={isNow ? { background: `${color}14` } : undefined}
                    >
                      <td className="py-2 pr-4">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: color }} />
                        <span style={{ color }} className="font-semibold">{r.regime}</span>
                        <span className="text-neutral-500 ml-2 text-[10px]">{r.label}</span>
                        {isNow && <span className="ml-2 text-[9px] tracking-widest" style={{ color }}>‹ NOW</span>}
                      </td>
                      <td className="py-2 px-2 text-right text-neutral-300 tabular-nums">{r.days}</td>
                      <td className="py-2 px-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-neutral-900 rounded-sm overflow-hidden">
                            <div className="h-full rounded-sm" style={{ width: `${Math.min(100, r.share * 4)}%`, background: color, opacity: 0.7 }} />
                          </div>
                          <span className="text-neutral-400 tabular-nums w-11 text-right">{r.share.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right text-neutral-400 tabular-nums">{r.avg_run.toFixed(1)}</td>
                      <td className="py-2 px-2 text-right tabular-nums" style={{ color: chgColor(r.btc_avg_daily_ret) }}>
                        {r.btc_avg_daily_ret !== null ? `${r.btc_avg_daily_ret >= 0 ? "+" : ""}${r.btc_avg_daily_ret.toFixed(2)}%` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right text-neutral-300 tabular-nums">
                        {r.btc_hit_rate !== null ? `${(r.btc_hit_rate * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums" style={{ color: chgColor(r.spx_avg_daily_ret) }}>
                        {r.spx_avg_daily_ret !== null ? `${r.spx_avg_daily_ret >= 0 ? "+" : ""}${r.spx_avg_daily_ret.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-neutral-600 text-sm">
            {loading ? "Loading regime stats..." : "No data"}
          </div>
        )}
      </div>

    </div>
  );
}
