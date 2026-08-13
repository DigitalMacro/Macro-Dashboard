"use client";

import { Info } from "lucide-react";
import { FACTOR_LABELS } from "@/lib/constants";

interface DegradedModelBannerProps {
  factorsMissing: string[];
  nFactors: number;
  nObs: number | null;
  firstDate: string | null;
}

export function DegradedModelBanner({
  factorsMissing, nFactors, nObs, firstDate,
}: DegradedModelBannerProps) {
  if (factorsMissing.length === 0) return null;

  const missingLabels = factorsMissing.map((f) => `${FACTOR_LABELS[f] ?? f} (${f})`);
  const window = nObs != null && firstDate ? ` · ${nObs} obs from ${firstDate}` : "";

  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
      <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
      <div className="text-sm">
        <p className="font-semibold">
          Running on {nFactors} of 12 factors{window}
        </p>
        <p className="mt-0.5 text-amber-800">
          {missingLabels.join(", ")} {factorsMissing.length === 1 ? "isn't" : "aren't"} in this fit.
          The model redistributes {factorsMissing.length === 1 ? "its" : "their"} explained variance
          across the remaining {nFactors} — every exposure below reflects that adjustment, not just
          the missing {factorsMissing.length === 1 ? "factor" : "factors"}.
        </p>
      </div>
    </div>
  );
}
