// STIR module fetch — deliberately isolated from lib/api.ts so
// next.config.mjs can alias this whole file away to a stub when
// NEXT_PUBLIC_ENABLE_STIR is unset, keeping it out of the production
// bundle rather than merely unrendered.

import type { StirSnapshot } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL;

export async function getStirSnapshot(): Promise<StirSnapshot> {
  const res = await fetch(`${BASE}/api/stir/snapshot`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err?.detail?.error ?? err?.error ?? res.statusText), {
      code: err?.detail?.code ?? "API_ERROR",
      status: res.status,
    });
  }

  const d = await res.json() as {
    as_of: string;
    effr: number;
    sofr: number;
    sofr_basis_bp: number;
    reference_rate_source: "FRED" | "fallback";
    data_source: string;
    fomc_dates: string[];
    sr3_strip: Array<{ symbol: string; expiry: string; settle: number; implied_rate: number; vs_ocr_bp: number }>;
    zq_strip:  Array<{ symbol: string; expiry: string; settle: number; implied_rate: number; vs_ocr_bp: number }>;
    sofr_terminal_symbol: string | null;
    ff_terminal_symbol:   string | null;
    meeting_path: Array<{
      meeting: string; post_rate: number; cum_cuts: number;
      hold: number; cut25: number; cut50: number; cut75: number; hike25: number;
    }>;
    spread_matrix: Array<{ contract: string; "+3M": number | null; "+6M": number | null; "+9M": number | null; "+12M": number | null }>;
    cb_levels: number[];
  };

  const mapContract = (c: typeof d.sr3_strip[0]) => ({
    symbol:      c.symbol,
    expiry:      c.expiry,
    settle:      c.settle,
    impliedRate: c.implied_rate,
    vsOcrBp:     c.vs_ocr_bp,
  });

  return {
    asOf:               d.as_of,
    effr:               d.effr,
    sofr:               d.sofr,
    sofrBasisBp:        d.sofr_basis_bp,
    referenceRateSource: d.reference_rate_source,
    dataSource:         d.data_source,
    fomcDates:          d.fomc_dates,
    sr3Strip:           d.sr3_strip.map(mapContract),
    zqStrip:            d.zq_strip.map(mapContract),
    sofrTerminalSymbol: d.sofr_terminal_symbol,
    ffTerminalSymbol:   d.ff_terminal_symbol,
    meetingPath:        d.meeting_path.map((p) => ({
      meeting:  p.meeting,
      postRate: p.post_rate,
      cumCuts:  p.cum_cuts,
      hold:     p.hold,
      cut25:    p.cut25,
      cut50:    p.cut50,
      cut75:    p.cut75,
      hike25:   p.hike25,
    })),
    spreadMatrix: d.spread_matrix,
    cbLevels:     d.cb_levels,
  };
}
