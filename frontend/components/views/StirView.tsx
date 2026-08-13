"use client";

import { useEffect, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { getStirSnapshot } from "@/lib/stirApi";
import type { StirSnapshot, StirContract, StirMeetingPoint, StirSpreadRow } from "@/lib/types";

// ── Brand palette (CFR) ───────────────────────────────────────────────────────
const ORANGE     = "#FE7C04";
const ORANGE_HOT = "#FF9533";
const ORANGE_DIM = "#C46A00";

// ── Utility formatters ────────────────────────────────────────────────────────
function fmt(n: number, dp = 2) { return n.toFixed(dp); }
function fmtBp(n: number) { return `${n >= 0 ? "+" : ""}${Math.round(n)}bp`; }

function shortDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}

// ── KPI pill ─────────────────────────────────────────────────────────────────
function KpiPill({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border bg-card px-5 py-3 min-w-[96px]">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="mt-0.5 text-xl font-bold tabular-nums" style={{ color: ORANGE }}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground mt-0.5">{sub}</span>}
    </div>
  );
}

// ── Strip chart (Products tab) ────────────────────────────────────────────────
function StripChart({
  strip, effr, terminalSymbol, title,
}: {
  strip: StirContract[];
  effr: number;
  terminalSymbol: string | null;
  title: string;
}) {
  if (strip.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No strip data available
      </div>
    );
  }

  const data = strip.map((c) => ({
    symbol:      c.symbol,
    impliedRate: parseFloat(c.impliedRate.toFixed(3)),
    isTerminal:  c.symbol === terminalSymbol,
  }));

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data} margin={{ left: 10, right: 20, top: 8, bottom: 32 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
          <XAxis
            dataKey="symbol"
            tick={{ fontSize: 11, fill: "#6b7280" }}
            angle={-35}
            textAnchor="end"
            interval={0}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${fmt(v, 2)}%`}
            tick={{ fontSize: 11, fill: "#6b7280" }}
            width={58}
          />
          <Tooltip
            formatter={(v: number) => [`${fmt(v, 3)}%`, "Implied rate"]}
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
          />
          <ReferenceLine
            y={effr}
            stroke={ORANGE}
            strokeDasharray="6 3"
            strokeWidth={1.5}
            label={{
              value: `EFFR ${fmt(effr)}%`,
              position: "insideTopRight",
              fontSize: 11,
              fill: ORANGE,
              fontWeight: 600,
            }}
          />
          <Bar dataKey="impliedRate" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.isTerminal ? ORANGE_HOT : ORANGE_DIM} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {terminalSymbol && (
        <p className="mt-1 text-xs text-muted-foreground text-right">
          <span
            className="inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold"
            style={{ backgroundColor: ORANGE_HOT, color: "#000" }}
          >
            {terminalSymbol}
          </span>{" "}
          = terminal rate
        </p>
      )}
    </div>
  );
}

// ── Products tab ──────────────────────────────────────────────────────────────
function ProductsTab({ snap }: { snap: StirSnapshot }) {
  const [product, setProduct] = useState<"SOFR" | "FF">("FF");

  const strip         = product === "SOFR" ? snap.sr3Strip  : snap.zqStrip;
  const terminalSym   = product === "SOFR" ? snap.sofrTerminalSymbol : snap.ffTerminalSymbol;
  const title         = product === "SOFR" ? "SOFR Futures Strip (SR3)" : "Fed Funds Futures Strip (ZQ)";

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={product === "SOFR" ? "default" : "outline"}
          onClick={() => setProduct("SOFR")}
          style={product === "SOFR" ? { backgroundColor: ORANGE, borderColor: ORANGE, color: "#000" } : {}}
        >
          SOFR
        </Button>
        <Button
          size="sm"
          variant={product === "FF" ? "default" : "outline"}
          onClick={() => setProduct("FF")}
          style={product === "FF" ? { backgroundColor: ORANGE, borderColor: ORANGE, color: "#000" } : {}}
        >
          FED FUNDS
        </Button>
        {product === "SOFR" && snap.sofrBasisBp !== 0 && (
          <span className="self-center text-xs text-muted-foreground ml-2">
            SOFR/EFFR basis: <strong>{fmtBp(snap.sofrBasisBp)}</strong>
          </span>
        )}
      </div>

      <StripChart
        strip={strip}
        effr={snap.effr}
        terminalSymbol={terminalSym}
        title={title}
      />
    </div>
  );
}

// ── Meeting strip (step chart) ────────────────────────────────────────────────
function MeetingStripChart({
  path, effr, cbLevels, showCbLvl,
}: {
  path: StirMeetingPoint[];
  effr: number;
  cbLevels: number[];
  showCbLvl: boolean;
}) {
  if (path.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No meeting path data — check ZQ strip availability
      </div>
    );
  }

  const data = path.map((p) => ({
    meeting:  shortDate(p.meeting),
    postRate: parseFloat(p.postRate.toFixed(4)),
    cumCuts:  p.cumCuts,
  }));

  const settle = Math.round(effr / 0.25) * 0.25;

  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={data} margin={{ left: 10, right: 60, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
        <XAxis dataKey="meeting" tick={{ fontSize: 11, fill: "#6b7280" }} />
        <YAxis
          domain={["auto", "auto"]}
          tickFormatter={(v) => `${fmt(v, 2)}%`}
          tick={{ fontSize: 11, fill: "#6b7280" }}
          width={58}
        />
        <Tooltip
          formatter={(v: number, name: string) =>
            name === "postRate"
              ? [`${fmt(v, 3)}%`, "Post-meeting rate"]
              : [v, name]
          }
          contentStyle={{ fontSize: 12, borderRadius: 6 }}
        />
        {/* EFFR dashed baseline */}
        <ReferenceLine
          y={effr}
          stroke={ORANGE}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{
            value: `EFFR ${fmt(effr)}%`,
            position: "insideTopRight",
            fontSize: 11,
            fill: ORANGE,
            fontWeight: 600,
          }}
        />
        {/* CB LVL rails — shown only when CB LVL sub-tab is active */}
        {showCbLvl &&
          cbLevels.map((lv) => {
            const isSettle = Math.abs(lv - settle) < 0.01;
            return (
              <ReferenceLine
                key={lv}
                y={lv}
                stroke={isSettle ? ORANGE : ORANGE_DIM}
                strokeDasharray={isSettle ? "0" : "4 4"}
                strokeWidth={isSettle ? 1.4 : 0.7}
                strokeOpacity={isSettle ? 1 : 0.6}
                label={
                  isSettle
                    ? {
                        value: `${fmt(lv, 2)}% · SETTLE`,
                        position: "insideRight",
                        fontSize: 10,
                        fill: ORANGE,
                      }
                    : {
                        value: `${fmt(lv, 2)}%`,
                        position: "insideRight",
                        fontSize: 9,
                        fill: "#9ca3af",
                      }
                }
              />
            );
          })}
        <Line
          type="stepAfter"
          dataKey="postRate"
          stroke={ORANGE_HOT}
          strokeWidth={2.4}
          dot={{ r: 5, fill: "#fff", stroke: ORANGE_HOT, strokeWidth: 2 }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Probability table ─────────────────────────────────────────────────────────
function ProbsTable({ path }: { path: StirMeetingPoint[] }) {
  if (path.length === 0) return null;

  return (
    <div className="overflow-x-auto mt-4">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="py-1.5 pr-3 text-left font-semibold text-muted-foreground">Meeting</th>
            <th className="py-1.5 px-2 text-right font-semibold text-muted-foreground">Rate</th>
            <th className="py-1.5 px-2 text-right font-semibold text-muted-foreground">Cum. cuts</th>
            <th className="py-1.5 px-2 text-right font-semibold text-green-700">Hold</th>
            <th className="py-1.5 px-2 text-right font-semibold text-blue-700">−25bp</th>
            <th className="py-1.5 px-2 text-right font-semibold text-blue-900">−50bp</th>
            <th className="py-1.5 px-2 text-right font-semibold text-red-700">+25bp</th>
          </tr>
        </thead>
        <tbody>
          {path.map((p) => (
            <tr key={p.meeting} className="border-b hover:bg-muted/40 transition-colors">
              <td className="py-1.5 pr-3 font-medium">{shortDate(p.meeting)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{fmt(p.postRate, 3)}%</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                {p.cumCuts >= 0 ? `−${fmt(p.cumCuts, 1)}` : `+${fmt(Math.abs(p.cumCuts), 1)}`}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-green-700">
                {p.hold > 0 ? `${fmt(p.hold, 0)}%` : "—"}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-blue-700">
                {p.cut25 > 0 ? `${fmt(p.cut25, 0)}%` : "—"}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-blue-900">
                {p.cut50 > 0 ? `${fmt(p.cut50, 0)}%` : "—"}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                {p.hike25 > 0 ? `${fmt(p.hike25, 0)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Spread matrix table ───────────────────────────────────────────────────────
function SpreadMatrixTable({ rows }: { rows: StirSpreadRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">No spread data available.</p>
    );
  }

  function bpColour(v: number | null): string {
    if (v === null) return "text-muted-foreground";
    if (v <= -20)   return "text-emerald-700 font-semibold";
    if (v < 0)      return "text-emerald-600";
    if (v === 0)    return "text-muted-foreground";
    if (v <= 20)    return "text-amber-600";
    return "text-red-600 font-semibold";
  }

  function bpBg(v: number | null): string {
    if (v === null) return "";
    const abs = Math.abs(v);
    if (abs >= 40)  return "bg-emerald-50";
    if (abs >= 20)  return "bg-emerald-50/60";
    if (v > 20)     return "bg-amber-50/60";
    return "";
  }

  const horizons = ["+3M", "+6M", "+9M", "+12M"] as const;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="py-1.5 pr-4 text-left font-semibold text-muted-foreground">Contract</th>
            {horizons.map((h) => (
              <th key={h} className="py-1.5 px-3 text-right font-semibold text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.contract} className="border-b hover:bg-muted/30 transition-colors">
              <td className="py-1.5 pr-4 font-mono font-semibold">{row.contract}</td>
              {horizons.map((h) => {
                const v = row[h];
                return (
                  <td
                    key={h}
                    className={`py-1.5 px-3 text-right tabular-nums rounded ${bpColour(v)} ${bpBg(v)}`}
                  >
                    {v !== null ? fmtBp(v) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Negative = lower forward rate (cuts priced). Positive = higher (hikes priced). Values in basis points.
      </p>
    </div>
  );
}

// ── Meetings tab ──────────────────────────────────────────────────────────────
function MeetingsTab({ snap }: { snap: StirSnapshot }) {
  return (
    <Tabs defaultValue="strip">
      <TabsList className="mb-4">
        <TabsTrigger value="strip">Strip</TabsTrigger>
        <TabsTrigger value="spreads">Spreads</TabsTrigger>
        <TabsTrigger value="cblvl">CB LVL</TabsTrigger>
      </TabsList>

      <TabsContent value="strip">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Meeting-path implied rates</CardTitle>
          </CardHeader>
          <CardContent>
            <MeetingStripChart
              path={snap.meetingPath}
              effr={snap.effr}
              cbLevels={snap.cbLevels}
              showCbLvl={false}
            />
            <ProbsTable path={snap.meetingPath} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="spreads">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Calendar spread matrix (basis points)</CardTitle>
          </CardHeader>
          <CardContent>
            <SpreadMatrixTable rows={snap.spreadMatrix} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="cblvl">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">CB LVL — policy-rate rails</CardTitle>
          </CardHeader>
          <CardContent>
            <MeetingStripChart
              path={snap.meetingPath}
              effr={snap.effr}
              cbLevels={snap.cbLevels}
              showCbLvl={true}
            />
            <p className="mt-2 text-[10px] text-muted-foreground">
              Horizontal rails at every 25 bp policy increment.
              Solid bright line = settlement level (EFFR rounded to nearest 25 bp).
            </p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function StirView() {
  const [snap,    setSnap]    = useState<StirSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSnap(await getStirSnapshot());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load STIR data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading STIR data…</span>
      </div>
    );
  }

  if (error || !snap) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-medium text-red-700">STIR data unavailable</p>
        <p className="mt-1 text-xs text-red-500">{error}</p>
        <button onClick={load} className="mt-3 text-xs text-red-600 underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header — KPIs + meta */}
      <div className="flex flex-wrap items-start gap-3">
        <KpiPill label="EFFR" value={`${fmt(snap.effr, 2)}%`} sub="Effective FFR" />
        <KpiPill label="SOFR" value={`${fmt(snap.sofr, 2)}%`} sub={`basis ${fmtBp(snap.sofrBasisBp)}`} />
        <div className="flex flex-col justify-center ml-auto text-right text-xs text-muted-foreground gap-0.5">
          <span>As of {snap.asOf}</span>
          <span
            className={
              snap.referenceRateSource === "fallback"
                ? "font-semibold text-amber-600"
                : ""
            }
          >
            Reference rates (EFFR/SOFR):{" "}
            {snap.referenceRateSource === "FRED"
              ? "FRED (live)"
              : "fallback constants — FRED unavailable"}
          </span>
          <span>Futures source: {snap.dataSource}</span>
          <button
            onClick={load}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Main tabs: PRODUCTS / MEETINGS */}
      <Tabs defaultValue="products">
        <TabsList className="mb-4">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="meetings">Meetings</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          <Card>
            <CardContent className="pt-6">
              <ProductsTab snap={snap} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="meetings">
          <MeetingsTab snap={snap} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
