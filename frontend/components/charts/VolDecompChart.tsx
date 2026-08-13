"use client";

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

interface VolDecompChartProps {
  dates: string[];
  factorVol: number[];
  specificVol: number[];
}

export function VolDecompChart({ dates, factorVol, specificVol }: VolDecompChartProps) {
  // Backend rolling vols are already annualised % units — no rescaling
  const data = dates.map((d, i) => ({
    date:        d.slice(0, 10),
    "Factor vol":   +factorVol[i].toFixed(2),
    "Specific vol": +specificVol[i].toFixed(2),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} />
        <Legend />
        <Area type="monotone" dataKey="Factor vol"   stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
        <Area type="monotone" dataKey="Specific vol" stackId="1" stroke="#f59e0b" fill="#fde68a" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
