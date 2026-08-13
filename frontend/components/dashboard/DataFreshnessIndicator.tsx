"use client";

import { Clock } from "lucide-react";

interface DataFreshnessIndicatorProps {
  asOf: string | null;
  source: string | null;
}

export function DataFreshnessIndicator({ asOf, source }: DataFreshnessIndicatorProps) {
  if (!asOf || !source) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="h-3 w-3" />
      <span>{source} as of {asOf}</span>
    </div>
  );
}
