"use client";

import { cn } from "@/lib/utils";

const RANGES = ["1M", "3M", "6M", "YTD", "1Y"] as const;

interface DateRangePickerProps {
  value: string;
  onChange: (range: string) => void;
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  return (
    <div className="flex rounded-md border border-input overflow-hidden">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium transition-colors",
            value === r
              ? "bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted text-muted-foreground",
            "border-r border-input last:border-r-0",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
