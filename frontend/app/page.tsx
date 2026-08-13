"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AssetSelector } from "@/components/dashboard/AssetSelector";
import { ModelBadge } from "@/components/dashboard/ModelBadge";
import { DataFreshnessIndicator } from "@/components/dashboard/DataFreshnessIndicator";
import { ReturnAttribution } from "@/components/views/ReturnAttribution";
import { RiskAttribution } from "@/components/views/RiskAttribution";
import { StressTesting } from "@/components/views/StressTesting";
import { ExposureHeatmap } from "@/components/views/ExposureHeatmap";
import { StirView } from "@/components/views/StirView";
import type { AssetInfo } from "@/lib/types";

const STIR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_STIR === "true";

export default function DashboardPage() {
  const [ticker,    setTicker]    = useState("SPY");
  const [assetInfo, setAssetInfo] = useState<AssetInfo | null>(null);
  const [freshness, setFreshness] = useState<{ asOf: string | null; source: string | null }>({
    asOf: null,
    source: null,
  });

  function handleAssetChange(t: string, info: AssetInfo) {
    setTicker(t);
    setAssetInfo(info);
  }

  function handleTabChange() {
    // Clear immediately on switch — don't show the previous tab's freshness
    // while the new tab loads. Tabs that never report (STIR) leave this at
    // nothing, which is correct: the header must never assert a source it
    // hasn't observed for the currently active tab.
    setFreshness({ asOf: null, source: null });
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-white/95 backdrop-blur sticky top-0 z-50">
        <div className="mx-auto max-w-screen-2xl px-4 py-3 flex items-center gap-4">
          <div className="shrink-0">
            <h1 className="text-base font-bold leading-none">MFERM</h1>
            <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
              Macro Factor Equity Risk Model
            </p>
          </div>
          <div className="flex-1 max-w-xl">
            <AssetSelector
              currentTicker={ticker}
              onAssetChange={handleAssetChange}
            />
          </div>
          <div className="shrink-0 flex items-center gap-3 ml-auto">
            {assetInfo && (
              <div className="text-right hidden sm:block">
                <p className="text-sm font-semibold">{assetInfo.name}</p>
                <p className="text-xs text-muted-foreground">
                  ${assetInfo.currentPrice.toFixed(2)} · {assetInfo.currency}
                </p>
              </div>
            )}
            <ModelBadge />
          </div>
        </div>
        <div className="mx-auto max-w-screen-2xl px-4 py-1 flex justify-end">
          <DataFreshnessIndicator asOf={freshness.asOf} source={freshness.source} />
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <Tabs defaultValue="return" onValueChange={handleTabChange}>
          <TabsList className="mb-6">
            <TabsTrigger value="return">Return Attribution</TabsTrigger>
            <TabsTrigger value="risk">Risk Attribution</TabsTrigger>
            <TabsTrigger value="stress">Stress Testing</TabsTrigger>
            <TabsTrigger value="heatmap">Exposure Heatmap</TabsTrigger>
            {STIR_ENABLED && <TabsTrigger value="stir">STIR</TabsTrigger>}
          </TabsList>

          {/* Error boundaries are per-view — one failing view does not crash others */}
          <ViewErrorBoundary>
            <TabsContent value="return">
              <ReturnAttribution ticker={ticker} onFreshness={setFreshness} />
            </TabsContent>
          </ViewErrorBoundary>

          <ViewErrorBoundary>
            <TabsContent value="risk">
              <RiskAttribution ticker={ticker} onFreshness={setFreshness} />
            </TabsContent>
          </ViewErrorBoundary>

          <ViewErrorBoundary>
            <TabsContent value="stress">
              <StressTesting ticker={ticker} onFreshness={setFreshness} />
            </TabsContent>
          </ViewErrorBoundary>

          <ViewErrorBoundary>
            <TabsContent value="heatmap">
              <ExposureHeatmap initialTicker={ticker} onFreshness={setFreshness} />
            </TabsContent>
          </ViewErrorBoundary>

          {STIR_ENABLED && (
            <ViewErrorBoundary>
              <TabsContent value="stir">
                {/* STIR is excluded from this pass and keeps its own inline
                    source line — never wired to the header indicator. */}
                <StirView />
              </TabsContent>
            </ViewErrorBoundary>
          )}
        </Tabs>
      </main>
    </div>
  );
}

// ── Simple error boundary ─────────────────────────────────────────────────────

import { Component, type ReactNode } from "react";

class ViewErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-medium text-red-700">This view encountered an error</p>
          <p className="mt-1 text-xs text-red-500">{this.state.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, message: "" })}
            className="mt-3 text-xs text-red-600 underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
