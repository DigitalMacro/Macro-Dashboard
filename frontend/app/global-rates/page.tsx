"use client";

/**
 * Global Rates — app/global-rates/page.tsx
 *
 * US, Euro Area, UK, Japan curves side by side. Per-market adapters upstream;
 * failed markets degrade gracefully (rendered as a muted notice).
 * API: GET /api/global-rates/snapshot?window=10
 *
 * UK note: BoE publishes no daily 2Y nominal zero-coupon series, so the UK
 * short leg is 5Y (slope labeled 5s10s) and its long tenor is 20Y.
 */

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { RefreshCw, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface OverlayPoint {
  date: string;
  normalized: number;
  raw: number;
}

interface MarketData {
  name: string;
  color: string;
  policy_rate: number | null;
  policy_rate_manual: boolean;
  policy_label: string;
  source: string | null;
  as_of: string | null;
  short_tenor: string;
  slope_label: string;
  tenors: Record<string, number>;
  changes_1m_bps: Record<string, number | null>;
  slope_2s10s_bps: number;
  regime: string;
  days_in_regime: number;
  curve_snapshot: { tenors: string[]; yields: number[] };
  overlay_10y: OverlayPoint[];
}

interface SlopeRank {
  market: string;
  slope_bps: number;
  slope_label: string;
}

interface Summary {
  steepest: string | null;
  flattest: string | null;
  inverted_count: number;
  n_markets: number;
  top_1m_riser_10y: string | null;
  us_10y: number | null;
  peer_median_10y: number | null;
  us_vs_median_bps: number | null;
}

interface GlobalRatesSnapshot {
  as_of: string;
  failed_markets: string[];
  markets: Record<string, MarketData>;
  slope_ranking: SlopeRank[];
  summary: Summary;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MARKET_ORDER = ["US", "DE", "UK", "JP"];

// Same regime palette as the Yield Curve module
const REGIME_COLORS: Record<string, string> = {
  bull_steepener: "#166534",
  bear_steepener: "#991B1B",
  bull_flattener: "#1E3A5F",
  bear_flattener: "#B45309",
  twist_bear:     "#6B21A8",
  twist_bull:     "#0E7490",
  neutral:        "#374151",
};

const REGIME_LABELS: Record<string, string> = {
  bull_steepener: "Bull Steepener",
  bear_steepener: "Bear Steepener",
  bull_flattener: "Bull Flattener",
  bear_flattener: "Bear Flattener",
  twist_bear:     "Bear Twist",
  twist_bull:     "Bull Twist",
  neutral:        "Neutral",
};

const GREEN = "#34d399";
const RED = "#f87171";
const AMBER = "#f59e0b";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBp(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}bp`;
}

// ── Info panel (same card style as Rate Decomp) ───────────────────────────────
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

// ── Overlay chart ─────────────────────────────────────────────────────────────
interface OverlayRow {
  date: string;
  [marketKey: string]: string | number | null;
}

function buildOverlayRows(markets: Record<string, MarketData>): OverlayRow[] {
  const byDate = new Map<string, OverlayRow>();
  for (const [code, m] of Object.entries(markets)) {
    for (const p of m.overlay_10y) {
      const row = byDate.get(p.date) ?? { date: p.date };
      row[code] = p.normalized;
      row[`${code}_raw`] = p.raw;
      byDate.set(p.date, row);
    }
  }
  return Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );
}

function OverlayTooltip({
  active, label, payload, markets,
}: {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string | number; payload?: OverlayRow }[];
  markets: Record<string, MarketData>;
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const row = payload[0].payload;
  return (
    <div className="bg-[#0f0f12] border border-neutral-700 rounded-md px-3 py-2 text-[11px] font-mono space-y-0.5">
      <p className="text-neutral-400">{label}</p>
      {MARKET_ORDER.filter((c) => markets[c] && row[`${c}_raw`] != null).map((c) => (
        <p key={c} style={{ color: markets[c].color }}>
          {c} {(row[`${c}_raw`] as number).toFixed(2)}%
        </p>
      ))}
    </div>
  );
}

function OverlayChart({ markets }: { markets: Record<string, MarketData> }) {
  const rows = buildOverlayRows(markets);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
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
        <YAxis hide domain={[0, 1]} />
        <Tooltip content={<OverlayTooltip markets={markets} />} />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        {MARKET_ORDER.filter((c) => markets[c]).map((c) => (
          <Line
            key={c}
            type="monotone"
            dataKey={c}
            stroke={markets[c].color}
            strokeWidth={1.5}
            dot={false}
            name={c}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Curve snapshots chart ─────────────────────────────────────────────────────
const SNAPSHOT_TENORS = ["2Y", "5Y", "10Y", "20Y", "30Y"];

interface CurveRow {
  tenor: string;
  [market: string]: string | number | null;
}

function buildCurveRows(markets: Record<string, MarketData>): CurveRow[] {
  return SNAPSHOT_TENORS
    .map((tenor) => {
      const row: CurveRow = { tenor };
      let any = false;
      for (const [code, m] of Object.entries(markets)) {
        const idx = m.curve_snapshot.tenors.indexOf(tenor);
        if (idx >= 0) {
          row[code] = m.curve_snapshot.yields[idx];
          any = true;
        } else {
          row[code] = null;
        }
      }
      return any ? row : null;
    })
    .filter((r): r is CurveRow => r !== null);
}

function CurveSnapshotChart({ markets }: { markets: Record<string, MarketData> }) {
  const rows = buildCurveRows(markets);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis
          dataKey="tenor"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v.toFixed(1)}%`}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace", paddingTop: 6 }} />
        {MARKET_ORDER.filter((c) => markets[c]).map((c) => (
          <Line
            key={c}
            type="monotone"
            dataKey={c}
            stroke={markets[c].color}
            strokeWidth={1.5}
            dot={{ r: 3, fill: markets[c].color }}
            name={c}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Slope ranking bars ────────────────────────────────────────────────────────
function SlopeRanking({
  ranking, markets, summary,
}: {
  ranking: SlopeRank[];
  markets: Record<string, MarketData>;
  summary: Summary;
}) {
  const maxAbs = Math.max(1, ...ranking.map((r) => Math.abs(r.slope_bps)));
  return (
    <div className="space-y-2">
      {ranking.map((r) => (
        <div key={r.market} className="flex items-center gap-2 text-[11px] font-mono">
          <span className="w-7 shrink-0" style={{ color: markets[r.market]?.color }}>{r.market}</span>
          <div className="flex-1 h-3 bg-neutral-900 rounded-sm overflow-hidden">
            <div
              className="h-full rounded-sm"
              style={{
                width: `${(Math.abs(r.slope_bps) / maxAbs) * 100}%`,
                background: r.slope_bps >= 0 ? GREEN : RED,
                opacity: 0.75,
              }}
            />
          </div>
          <span className="w-14 text-right tabular-nums" style={{ color: r.slope_bps >= 0 ? GREEN : RED }}>
            {fmtBp(r.slope_bps)}
          </span>
          <span className="w-11 text-[9px] text-neutral-600 uppercase">{r.slope_label}</span>
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-2 text-[9px] font-mono tracking-wider text-neutral-500 uppercase">
        <span className="px-2 py-0.5 rounded border border-neutral-800">
          Steepest {summary.steepest} {fmtBp(ranking[0]?.slope_bps)}
        </span>
        <span className="px-2 py-0.5 rounded border border-neutral-800">
          Flattest {summary.flattest} {fmtBp(ranking[ranking.length - 1]?.slope_bps)}
        </span>
        <span className="px-2 py-0.5 rounded border border-neutral-800">
          Inverted {summary.inverted_count} of {summary.n_markets}
        </span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function GlobalRatesPage() {
  const [data, setData] = useState<GlobalRatesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/global-rates/snapshot?window=10");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: GlobalRatesSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load global rates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const markets = data?.markets ?? {};
  const present = MARKET_ORDER.filter((c) => markets[c]);
  const s = data?.summary;

  // 1M change table, sorted descending by 10Y change
  const changeRows = present
    .map((c) => ({
      code: c,
      level: markets[c].tenors["10Y"],
      chg: markets[c].changes_1m_bps["10Y"] ?? null,
    }))
    .sort((a, b) => (b.chg ?? -1e9) - (a.chg ?? -1e9));

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono tracking-widest text-neutral-600 uppercase">
              Global Rates
            </span>
            <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
              LIVE
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Global · Rates</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            US, Euro Area, UK and Japan curves side by side · daily close
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

      {/* ── Error / degraded sources ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}
      {data && data.failed_markets.length > 0 && (
        <div className="p-3 rounded-lg bg-neutral-900/60 border border-neutral-800 text-neutral-500 text-[11px] font-mono">
          {data.failed_markets.join(", ")} unavailable · source fetch failed
        </div>
      )}

      {/* ── Policy rate cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
        {present.map((c) => {
          const m = markets[c];
          return (
            <div key={c} className="flex flex-col gap-1 px-5 py-4">
              <span className="text-[10px] tracking-widest uppercase font-mono" style={{ color: m.color }}>
                {m.name}
              </span>
              <span className="text-xl font-semibold font-mono tabular-nums text-[#F0F0F0]">
                {m.policy_label} {m.policy_rate !== null ? `${m.policy_rate.toFixed(2)}%` : "—"}
                {m.policy_rate_manual && (
                  <span className="text-neutral-600" title="Manually maintained — update on policy changes"> ·</span>
                )}
              </span>
              <span className="text-[10px] text-neutral-600 font-mono">{m.source}</span>
            </div>
          );
        })}
      </div>

      {/* ── 10Y overlay + 1M change table ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            10Y Nominal Yield Overlay
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            PER-MARKET AXIS · EACH LINE SCALED TO ITS OWN 1Y RANGE · DAILY CLOSE
          </span>
          {present.length ? (
            <>
              <OverlayChart markets={markets} />
              <p className="text-[9px] font-mono tracking-wider text-neutral-700 mt-2">
                NO SHARED Y SCALE — EACH MARKET NORMALIZED TO ITS OWN 1Y MIN/MAX
              </p>
            </>
          ) : (
            <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading yields..." : "No data"}
            </div>
          )}
        </div>
        <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-3">
            1M Change · 10Y
          </span>
          <div className="space-y-2">
            {changeRows.map((r) => (
              <div key={r.code} className="flex items-center justify-between text-xs font-mono border-b border-neutral-800/50 pb-2">
                <span style={{ color: markets[r.code].color }}>{r.code}</span>
                <span className="text-neutral-300 tabular-nums">{r.level?.toFixed(2)}%</span>
                <span className="tabular-nums" style={{ color: (r.chg ?? 0) >= 0 ? GREEN : RED }}>
                  {fmtBp(r.chg)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Curve snapshots + slope ranking ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-3 bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block">
            Nominal Curve Snapshots
          </span>
          <span className="text-[9px] font-mono tracking-wider text-neutral-600 block mb-4">
            LATEST CLOSE · TENORS 2Y 5Y 10Y 20Y 30Y · PERCENT · UK LONG END = 20Y
          </span>
          {present.length ? (
            <CurveSnapshotChart markets={markets} />
          ) : (
            <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading curves..." : "No data"}
            </div>
          )}
        </div>
        <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
          <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-3">
            Curve Slope Ranking
          </span>
          {data && s ? (
            <SlopeRanking ranking={data.slope_ranking} markets={markets} summary={s} />
          ) : (
            <div className="h-32 flex items-center justify-center text-neutral-600 text-sm">
              {loading ? "Loading..." : "No data"}
            </div>
          )}
          <p className="text-[9px] font-mono text-neutral-700 mt-3">
            UK slope is 5s10s — BoE publishes no daily 2Y zero-coupon series
          </p>
        </div>
      </div>

      {/* ── Regime strip ── */}
      <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-4">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-3">
          Curve Regimes · 10D Window
        </span>
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {present.map((c) => {
            const m = markets[c];
            return (
              <span key={c} className="flex items-center gap-2 text-xs font-mono">
                <span style={{ color: m.color }}>{c}</span>
                <span
                  className="uppercase tracking-wider font-semibold"
                  style={{ color: REGIME_COLORS[m.regime] ?? "#6b7280" }}
                >
                  {REGIME_LABELS[m.regime] ?? m.regime}
                </span>
                <span className="text-neutral-600">{m.days_in_regime}D</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* ── Panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <InfoPanel title="What This Is">
          <p>
            Ten-year yields are the anchor point of every rates market. Each overlay line is drawn
            on its own axis, scaled to its own one-year range, so every market&apos;s shape is
            readable next to the others — levels differ for structural reasons, so the one-month
            change column is the cleaner cross-market signal.
          </p>
        </InfoPanel>
        {s && (
          <InfoPanel title="Current Reading">
            <p>steepest · <span className="text-neutral-200">{s.steepest}</span></p>
            <p>flattest · <span className="text-neutral-200">{s.flattest}</span></p>
            <p>
              us 10y vs peer median ·{" "}
              <span className="text-neutral-200">
                {s.us_10y?.toFixed(2)}% vs {s.peer_median_10y?.toFixed(2)}% ({fmtBp(s.us_vs_median_bps)})
              </span>
            </p>
            <p>top 1m riser (10y) · <span className="text-neutral-200">{s.top_1m_riser_10y}</span></p>
          </InfoPanel>
        )}
      </div>

    </div>
  );
}
