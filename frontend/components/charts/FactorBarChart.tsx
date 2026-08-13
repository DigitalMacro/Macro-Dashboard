"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Cell,
} from "recharts";
import { FACTOR_LABELS } from "@/lib/constants";

interface FactorBarChartProps {
  data: Record<string, number>;
  title?: string;
  valueLabel?: string;
  formatValue?: (v: number) => string;
}

export function FactorBarChart({
  data,
  valueLabel = "Value",
  formatValue = (v) => v.toFixed(3),
}: FactorBarChartProps) {
  const items = Object.entries(data)
    .map(([factor, value]) => ({
      factor,
      label: FACTOR_LABELS[factor] ?? factor,
      value,
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, items.length * 32)}>
      <BarChart data={items} layout="vertical" margin={{ left: 160, right: 40, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={formatValue} tick={{ fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="label"
          width={155}
          tick={{ fontSize: 12 }}
          interval={0}
        />
        <Tooltip formatter={(v: number) => [formatValue(v), valueLabel]} />
        <ReferenceLine x={0} stroke="#6b7280" strokeWidth={1} />
        <Bar dataKey="value" radius={[0, 3, 3, 0]}>
          {items.map((entry) => (
            <Cell
              key={entry.factor}
              fill={entry.value >= 0 ? "#16a34a" : "#dc2626"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
