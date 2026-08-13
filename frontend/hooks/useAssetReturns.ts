"use client";

import { useState, useEffect } from "react";
import { getAttribution, getRisk, getExposures, getRollingRisk } from "@/lib/api";
import type { Attribution, RiskAttribution, FactorExposures, RollingRisk } from "@/lib/types";
import { getDateRangeDates } from "@/lib/utils";

export function useAssetModel(ticker: string, dateRange = "1Y") {
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [risk,        setRisk]        = useState<RiskAttribution | null>(null);
  const [exposures,   setExposures]   = useState<FactorExposures | null>(null);
  const [rollingRisk, setRollingRisk] = useState<RollingRisk | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const { start, end } = getDateRangeDates(dateRange);

    Promise.all([
      getAttribution(ticker, start, end),
      getRisk(ticker),
      getExposures(ticker),
      getRollingRisk(ticker),
    ])
      .then(([attr, rsk, exp, roll]) => {
        if (!cancelled) {
          setAttribution(attr);
          setRisk(rsk);
          setExposures(exp);
          setRollingRisk(roll);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [ticker, dateRange]);

  return { attribution, risk, exposures, rollingRisk, loading, error };
}
