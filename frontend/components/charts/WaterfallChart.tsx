"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import { FACTOR_LABELS } from "@/lib/constants";

interface WaterfallChartProps {
  factorImpacts: Record<string, number>;
  totalImpact: number;
}

export function WaterfallChart({ factorImpacts, totalImpact }: WaterfallChartProps) {
  const items = Object.entries(factorImpacts)
    .filter(([, v]) => Math.abs(v) > 0.0001)
    .map(([factor, value]) => ({
      factor,
      label: FACTOR_LABELS[factor] ?? factor,
      value,
    }))
    .sort((a, b) => a.value - b.value);

  // Add total bar
  const data = [
    ...items,
    { factor: "total", label: "Total impact", value: totalImpact },
  ];

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32)}>
      <BarChart data={data} layout="vertical" margin={{ left: 160, right: 60, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="label" width={155} tick={{ fontSize: 12 }} interval={0} />
        <Tooltip formatter={(v: number) => [`${v.toFixed(3)}%`, "Impact"]} />
        <ReferenceLine x={0} stroke="#374151" strokeWidth={1} />
        <Bar dataKey="value" radius={[0, 3, 3, 0]}>
          {data.map((entry) => (
            <Cell
              key={entry.factor}
              fill={
                entry.factor === "total"
                  ? entry.value >= 0 ? "#15803d" : "#b91c1c"
                  : entry.value >= 0 ? "#86efac" : "#fca5a5"
              }
              stroke={entry.factor === "total" ? "#111" : undefined}
              strokeWidth={entry.factor === "total" ? 1 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
