"use client";

/**
 * Portfolio — L/S Book — app/portfolio/page.tsx
 *
 * Mock long/short paper-trading book: manual entries, daily mark-to-market,
 * factor decomposition via the MFERM PLSR model, SPY-relative performance.
 * API: /api/portfolio/*
 */

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import { RefreshCw, Clock, Plus, X, AlertTriangle } from "lucide-react";
import { FACTOR_LABELS } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Position {
  id: number;
  ticker: string;
  side: "long" | "short";
  weight: number;
  entry_date: string;
  entry_price: number | null;
  exit_date: string | null;
  exit_price: number | null;
  thesis: string | null;
  status: "open" | "closed";
  current_price: number | null;
  pnl_pct: number | null;
  pnl_contribution_bps: number | null;
}

interface Summary {
  gross_exposure: number;
  net_exposure: number;
  long_exposure: number;
  short_exposure: number;
  n_open: number;
  n_closed: number;
  total_pnl_bps: number;
  realized_pnl_bps: number;
  unrealized_pnl_bps: number;
  spy_return_since_inception_pct: number | null;
  portfolio_return_pct: number;
  active_return_pct: number | null;
  factor_coverage_pct: number | null;
}

interface PnlPoint {
  date: string;
  portfolio_cum_bps: number;
  spy_cum_pct: number | null;
}

interface RegimeContext {
  current_regime: string | null;
  regime_consistency_score: number | null;
}

interface PortfolioSnapshot {
  as_of: string;
  positions: Position[];
  summary: Summary;
  pnl_series: PnlPoint[];
  factor_exposures: Record<string, number>;
  factor_pnl_attribution: Record<string, number>;
  regime_context: RegimeContext;
}

interface RegimeTsPoint {
  date: string;
  regime: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const REGIME_BG: Record<string, string> = {
  run_it_hot:  "rgba(180,83,9,0.15)",
  stagflation: "rgba(153,27,27,0.25)",
  goldilocks:  "rgba(22,101,52,0.15)",
  debasement:  "rgba(30,58,95,0.15)",
};

const GREEN = "#34d399";
const RED = "#f87171";
const AMBER = "#f59e0b";
const BLUE = "#38bdf8";
const ORANGE = "#fb923c";
const MUTED = "#6b7280";

// ── Helpers ───────────────────────────────────────────────────────────────────
function pnlColor(v: number | null): string {
  if (v === null) return "#6b7280";
  return v >= 0 ? GREEN : RED;
}

function fmtBps(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} bps`;
}

function fmtPct(v: number | null, dp = 2): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

function fmtPx(v: number | null): string {
  return v === null || v === undefined ? "—" : v.toFixed(2);
}

function regimeFitLabel(score: number | null): { label: string; color: string } {
  if (score === null) return { label: "—", color: MUTED };
  if (score > 0.3) return { label: "Consistent", color: GREEN };
  if (score < -0.3) return { label: "Contrarian", color: RED };
  return { label: "Neutral", color: AMBER };
}

// Label each daily P&L point with the prevailing regime, then merge runs —
// regime ts is monthly, so bands must be built on the chart's own x values.
function buildPnlBands(pnl: PnlPoint[], regimeTs: RegimeTsPoint[]) {
  if (!pnl.length || !regimeTs.length) return [];
  const sorted = [...regimeTs].sort((a, b) => a.date.localeCompare(b.date));
  const regimeAt = (date: string): string => {
    let current = sorted[0].regime;
    for (const r of sorted) {
      if (r.date <= date) current = r.regime;
      else break;
    }
    return current;
  };
  const bands: { start: string; end: string; regime: string }[] = [];
  let current = regimeAt(pnl[0].date);
  let start = pnl[0].date;
  for (let i = 1; i < pnl.length; i++) {
    const r = regimeAt(pnl[i].date);
    if (r !== current) {
      bands.push({ start, end: pnl[i].date, regime: current });
      current = r;
      start = pnl[i].date;
    }
  }
  bands.push({ start, end: pnl[pnl.length - 1].date, regime: current });
  return bands;
}

// ── KPI card ──────────────────────────────────────────────────────────────────
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
      {sub && <span className="text-[11px] text-neutral-500 font-mono">{sub}</span>}
    </div>
  );
}

// ── Add Position modal ────────────────────────────────────────────────────────
interface AddPositionModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function AddPositionModal({ onClose, onCreated }: AddPositionModalProps) {
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState<"long" | "short">("long");
  const [weight, setWeight] = useState("5");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [thesis, setThesis] = useState("");
  const [tickerStatus, setTickerStatus] = useState<"unchecked" | "checking" | "valid" | "invalid">("unchecked");
  const [tickerName, setTickerName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const checkTicker = useCallback(async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setTickerStatus("checking");
    try {
      const res = await fetch(`/api/asset/validate/${encodeURIComponent(t)}`);
      if (!res.ok) {
        setTickerStatus("invalid");
        setTickerName("");
        return;
      }
      const json: { name?: string } = await res.json();
      setTickerStatus("valid");
      setTickerName(json.name ?? "");
    } catch {
      setTickerStatus("invalid");
      setTickerName("");
    }
  }, [ticker]);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/portfolio/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase(),
          side,
          weight: parseFloat(weight),
          entry_date: entryDate,
          thesis: thesis.trim() || null,
        }),
      });
      if (!res.ok) {
        const body: { detail?: { error?: string } } = await res.json().catch(() => ({}));
        throw new Error(body.detail?.error ?? `HTTP ${res.status}`);
      }
      onCreated();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create position");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "bg-neutral-950 border border-neutral-700 rounded px-3 py-1.5 text-sm font-mono text-white " +
    "focus:outline-none focus:border-amber-500/60 w-full";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md bg-[#111116] border border-neutral-700 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Add Position</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3 text-xs font-mono">
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">Ticker</label>
            <input
              className={inputCls}
              value={ticker}
              onChange={(e) => { setTicker(e.target.value.toUpperCase()); setTickerStatus("unchecked"); }}
              onBlur={checkTicker}
              placeholder="NVDA"
            />
            {tickerStatus === "checking" && <p className="mt-1 text-neutral-500">Validating…</p>}
            {tickerStatus === "valid" && <p className="mt-1 text-emerald-400">✓ {tickerName || "Valid"}</p>}
            {tickerStatus === "invalid" && <p className="mt-1 text-red-400">Invalid ticker</p>}
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">Side</label>
            <div className="flex gap-2">
              <button
                onClick={() => setSide("long")}
                className={`px-4 py-1.5 rounded uppercase tracking-wider border transition-all ${
                  side === "long"
                    ? "bg-emerald-900/40 text-emerald-400 border-emerald-700"
                    : "text-neutral-500 border-neutral-700 hover:border-neutral-500"
                }`}
              >
                Long
              </button>
              <button
                onClick={() => setSide("short")}
                className={`px-4 py-1.5 rounded uppercase tracking-wider border transition-all ${
                  side === "short"
                    ? "bg-red-900/40 text-red-400 border-red-700"
                    : "text-neutral-500 border-neutral-700 hover:border-neutral-500"
                }`}
              >
                Short
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
                Weight (% of book)
              </label>
              <input
                className={inputCls}
                type="number"
                min="0.1"
                max="25"
                step="0.5"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">Entry Date</label>
              <input
                className={inputCls}
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
              Thesis (optional)
            </label>
            <input
              className={inputCls}
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              placeholder="One-line rationale"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-2.5 rounded bg-red-900/20 border border-red-800 text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={submitting || !ticker.trim() || tickerStatus === "invalid"}
            className="w-full py-2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 uppercase tracking-widest hover:bg-amber-500/30 transition-all disabled:opacity-40"
          >
            {submitting ? "Adding…" : "Add Position"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── P&L chart ─────────────────────────────────────────────────────────────────
function PnlChart({
  pnl, regimeTs,
}: {
  pnl: PnlPoint[];
  regimeTs: RegimeTsPoint[];
}) {
  const bands = buildPnlBands(pnl, regimeTs);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={pnl} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        {bands.map((b, i) => (
          <ReferenceArea
            key={i}
            yAxisId="left"
            x1={b.start}
            x2={b.end}
            fill={REGIME_BG[b.regime] ?? "rgba(0,0,0,0)"}
            fillOpacity={1}
          />
        ))}
        <XAxis
          dataKey="date"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={50}
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          label={{ value: "bps", angle: -90, position: "insideLeft", fill: AMBER, fontSize: 10 }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
          label={{ value: "SPY %", angle: 90, position: "insideRight", fill: MUTED, fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number, name: string) =>
            name === "Portfolio (bps)" ? [`${v.toFixed(1)} bps`, name] : [`${v.toFixed(2)}%`, name]
          }
        />
        <Legend wrapperStyle={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", paddingTop: 8 }} />
        <ReferenceLine yAxisId="left" y={0} stroke="#374151" strokeDasharray="4 4" />
        <Line yAxisId="left" type="monotone" dataKey="portfolio_cum_bps" stroke={AMBER} strokeWidth={1.5} dot={false} name="Portfolio (bps)" />
        <Line yAxisId="right" type="monotone" dataKey="spy_cum_pct" stroke={MUTED} strokeWidth={1.5} dot={false} name="SPY (%)" />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Factor bar panel ──────────────────────────────────────────────────────────
function FactorBars({
  data, unit,
}: {
  data: Record<string, number>;
  unit: "beta" | "bps";
}) {
  const items = Object.entries(data)
    .map(([k, v]) => ({
      name: k === "residual" ? "Residual" : (FACTOR_LABELS[k] ?? k),
      value: v,
      isResidual: k === "residual",
    }))
    .sort((a, b) => {
      // residual pinned last, rest by |value| desc
      if (a.isResidual) return 1;
      if (b.isResidual) return -1;
      return Math.abs(b.value) - Math.abs(a.value);
    });

  if (!items.length) {
    return <p className="text-xs text-neutral-600 font-mono">No factor data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, items.length * 26)}>
      <BarChart data={items} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: "#6b7280", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={130}
          tick={{ fill: "#9ca3af", fontSize: 10, fontFamily: "monospace" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{ background: "#0f0f12", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "#9ca3af", fontFamily: "monospace" }}
          itemStyle={{ fontFamily: "monospace" }}
          formatter={(v: number) => [unit === "beta" ? v.toFixed(4) : `${v.toFixed(1)} bps`, unit === "beta" ? "Net beta" : "Attributed P&L"]}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        <ReferenceLine x={0} stroke="#374151" />
        <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={12} name={unit === "beta" ? "Net beta" : "Attributed P&L"}>
          {items.map((it, i) => (
            <Cell key={i} fill={it.isResidual ? MUTED : it.value >= 0 ? BLUE : ORANGE} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Positions table ───────────────────────────────────────────────────────────
function PositionsTable({
  positions, onClosePosition, onDelete,
}: {
  positions: Position[];
  onClosePosition: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed");
  const [showClosed, setShowClosed] = useState(false);

  const th = "text-left text-neutral-500 uppercase tracking-wider pb-2 px-2 font-normal";

  function row(p: Position, muted = false) {
    return (
      <tr key={p.id} className={`border-t border-neutral-800/50 ${muted ? "opacity-50" : ""}`}>
        <td className="py-2 px-2 font-semibold text-neutral-200">{p.ticker}</td>
        <td className="py-2 px-2">
          <span
            className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-widest border ${
              p.side === "long"
                ? "bg-emerald-900/40 text-emerald-400 border-emerald-800"
                : "bg-red-900/40 text-red-400 border-red-800"
            }`}
          >
            {p.side === "long" ? "L" : "S"}
          </span>
        </td>
        <td className="py-2 px-2 text-neutral-300">{p.weight.toFixed(1)}%</td>
        <td className="py-2 px-2 text-neutral-400">{p.entry_date}</td>
        <td className="py-2 px-2 text-neutral-300">{fmtPx(p.entry_price)}</td>
        <td className="py-2 px-2 text-neutral-300">{fmtPx(p.current_price)}</td>
        <td className="py-2 px-2" style={{ color: pnlColor(p.pnl_pct) }}>{fmtPct(p.pnl_pct)}</td>
        <td className="py-2 px-2" style={{ color: pnlColor(p.pnl_contribution_bps) }}>
          {p.pnl_contribution_bps === null ? "—" : `${p.pnl_contribution_bps >= 0 ? "+" : ""}${p.pnl_contribution_bps.toFixed(1)}`}
        </td>
        <td className="py-2 px-2 text-neutral-500 max-w-[180px] truncate" title={p.thesis ?? ""}>
          {p.thesis ?? "—"}
        </td>
        <td className="py-2 px-2 whitespace-nowrap">
          {p.status === "open" && (
            <button
              onClick={() => onClosePosition(p.id)}
              className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:border-amber-500/50 hover:text-amber-400 mr-1.5 transition-all"
            >
              Close
            </button>
          )}
          <button
            onClick={() => onDelete(p.id)}
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-neutral-700 text-neutral-500 hover:border-red-500/50 hover:text-red-400 transition-all"
          >
            Delete
          </button>
        </td>
      </tr>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className={th}>Ticker</th>
            <th className={th}>Side</th>
            <th className={th}>Weight</th>
            <th className={th}>Entry Date</th>
            <th className={th}>Entry Px</th>
            <th className={th}>Current Px</th>
            <th className={th}>P&amp;L %</th>
            <th className={th}>Contrib (bps)</th>
            <th className={th}>Thesis</th>
            <th className={th}>Actions</th>
          </tr>
        </thead>
        <tbody>{open.map((p) => row(p))}</tbody>
      </table>

      {closed.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowClosed(!showClosed)}
            className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 hover:text-neutral-300"
          >
            {showClosed ? "▾" : "▸"} Closed positions ({closed.length})
          </button>
          {showClosed && (
            <table className="w-full text-xs font-mono border-collapse mt-2">
              <tbody>{closed.map((p) => row(p, true))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const [data, setData] = useState<PortfolioSnapshot | null>(null);
  const [regimeTs, setRegimeTs] = useState<RegimeTsPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portfolio/snapshot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: PortfolioSnapshot = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load portfolio");
    } finally {
      setLoading(false);
    }
  }, []);

  // Regime time series for chart shading — fetched once, non-fatal on failure
  useEffect(() => {
    fetch("/api/regime/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { time_series?: RegimeTsPoint[] } | null) => {
        if (j?.time_series) setRegimeTs(j.time_series.map((p) => ({ date: p.date, regime: p.regime })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleClose(id: number) {
    const today = new Date().toISOString().slice(0, 10);
    if (!window.confirm(`Close position #${id} as of ${today}?`)) return;
    try {
      const res = await fetch(`/api/portfolio/positions/${id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exit_date: today }),
      });
      if (!res.ok) {
        const body: { detail?: { error?: string } } = await res.json().catch(() => ({}));
        throw new Error(body.detail?.error ?? `HTTP ${res.status}`);
      }
      fetchData();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Close failed");
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm(`Delete position #${id} permanently?`)) return;
    try {
      const res = await fetch(`/api/portfolio/positions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchData();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const s = data?.summary;
  const fit = regimeFitLabel(data?.regime_context.regime_consistency_score ?? null);
  const hasPositions = (data?.positions.length ?? 0) > 0;

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
          <h1 className="text-xl font-semibold tracking-tight">Portfolio — L/S Book</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            Paper-trading book · daily mark-to-market · MFERM factor overlay · vs SPY
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
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/40 rounded px-3 py-1.5 hover:bg-amber-500/30 transition-all"
          >
            <Plus className="w-3 h-3" /> Add Position
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="p-4 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && data && !hasPositions ? (
        <div className="flex flex-col items-center justify-center gap-4 py-24 bg-neutral-900/60 rounded-lg border border-neutral-800">
          <p className="text-sm text-neutral-400 font-mono">
            No positions yet. Add your first L/S position to start tracking.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/40 rounded px-4 py-2 hover:bg-amber-500/30 transition-all"
          >
            <Plus className="w-3 h-3" /> Add Position
          </button>
        </div>
      ) : (
        <>
          {/* ── KPI Strip ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 bg-neutral-900/60 rounded-lg border border-neutral-800 divide-x divide-neutral-800">
            <KpiCard
              label="Total P&L"
              value={s ? fmtBps(s.total_pnl_bps) : "—"}
              color={s ? pnlColor(s.total_pnl_bps) : undefined}
              sub={s ? `real ${fmtBps(s.realized_pnl_bps)}` : undefined}
            />
            <KpiCard
              label="vs SPY"
              value={s ? fmtPct(s.active_return_pct) : "—"}
              color={s && s.active_return_pct !== null ? pnlColor(s.active_return_pct) : undefined}
              sub={s && s.spy_return_since_inception_pct !== null ? `SPY ${fmtPct(s.spy_return_since_inception_pct)}` : undefined}
            />
            <KpiCard
              label="Gross Exposure"
              value={s ? `${s.gross_exposure.toFixed(1)}%` : "—"}
            />
            <KpiCard
              label="Net Exposure"
              value={s ? `${s.net_exposure >= 0 ? "+" : ""}${s.net_exposure.toFixed(1)}%` : "—"}
              sub={s ? `${s.long_exposure.toFixed(0)}L / ${s.short_exposure.toFixed(0)}S` : undefined}
            />
            <KpiCard
              label="Open Positions"
              value={s ? s.n_open.toString() : "—"}
              sub={s && s.n_closed > 0 ? `${s.n_closed} closed` : undefined}
            />
            <KpiCard
              label="Regime Fit"
              value={fit.label}
              color={fit.color}
              sub={
                data?.regime_context.current_regime
                  ? `${data.regime_context.current_regime.replace(/_/g, " ")}${
                      data.regime_context.regime_consistency_score !== null
                        ? ` · ${data.regime_context.regime_consistency_score.toFixed(2)}`
                        : ""
                    }`
                  : undefined
              }
            />
          </div>

          {/* ── P&L chart ── */}
          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
              Cumulative P&L (bps) vs SPY (%) — Regime Shading
            </span>
            {data?.pnl_series?.length ? (
              <PnlChart pnl={data.pnl_series} regimeTs={regimeTs} />
            ) : (
              <div className="h-64 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Building P&L series..." : "No data"}
              </div>
            )}
          </div>

          {/* ── Positions table ── */}
          <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
              Positions — Sorted by Contribution
            </span>
            {data ? (
              <PositionsTable
                positions={data.positions}
                onClosePosition={handleClose}
                onDelete={handleDelete}
              />
            ) : (
              <div className="h-32 flex items-center justify-center text-neutral-600 text-sm">
                {loading ? "Loading positions..." : "No data"}
              </div>
            )}
          </div>

          {/* ── Factor panel ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
              <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
                Net Factor Exposures (β)
                {s?.factor_coverage_pct !== null && s?.factor_coverage_pct !== undefined && s.factor_coverage_pct < 100 && (
                  <span className="ml-2 text-amber-500/80">· {s.factor_coverage_pct.toFixed(0)}% of gross modeled</span>
                )}
              </span>
              {data && Object.keys(data.factor_exposures).length > 0 ? (
                <FactorBars data={data.factor_exposures} unit="beta" />
              ) : (
                <p className="text-xs text-neutral-600 font-mono">No open positions to model</p>
              )}
            </div>
            <div className="bg-neutral-900/60 rounded-lg border border-neutral-800 p-5">
              <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-500 block mb-4">
                Factor P&L Attribution (bps)
              </span>
              {data && Object.keys(data.factor_pnl_attribution).length > 0 ? (
                <FactorBars data={data.factor_pnl_attribution} unit="bps" />
              ) : (
                <p className="text-xs text-neutral-600 font-mono">No attribution data</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Add Position modal ── */}
      {showAdd && (
        <AddPositionModal onClose={() => setShowAdd(false)} onCreated={fetchData} />
      )}
    </div>
  );
}
