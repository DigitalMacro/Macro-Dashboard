"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

interface CumulativeReturnChartProps {
  dates: string[];
  actualReturn: number[];
  factorReturn: number[];
  specificReturn: number[];
}

function cumsum(arr: number[]): number[] {
  let s = 0;
  return arr.map((v) => (s += v));
}

export function CumulativeReturnChart({
  dates, actualReturn, factorReturn, specificReturn,
}: CumulativeReturnChartProps) {
  const cumActual   = cumsum(actualReturn);
  const cumFactor   = cumsum(factorReturn);
  const cumSpecific = cumsum(specificReturn);

  const chartData = dates.map((d, i) => ({
    date:     d.slice(0, 10),
    Actual:   +cumActual[i]?.toFixed(2),
    Factor:   +cumFactor[i]?.toFixed(2),
    Specific: +cumSpecific[i]?.toFixed(2),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} />
        <Legend />
        <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="Actual"   stroke="#1d4ed8" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="Factor"   stroke="#16a34a" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
        <Line type="monotone" dataKey="Specific" stroke="#f59e0b" dot={false} strokeWidth={1.5} strokeDasharray="2 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}
