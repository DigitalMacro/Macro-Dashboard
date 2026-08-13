"use client";

import { useState, useEffect, useRef } from "react";
import { Search, X, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { validateTicker } from "@/lib/api";
import type { AssetInfo } from "@/lib/types";
import { PRESET_TICKERS } from "@/lib/constants";

const RECENT_KEY = "mferm_recent_tickers";
const MAX_RECENT  = 5;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent(ticker: string) {
  const prev   = loadRecent().filter((t) => t !== ticker);
  const next   = [ticker, ...prev].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

interface AssetSelectorProps {
  onAssetChange: (ticker: string, assetInfo: AssetInfo) => void;
  currentTicker: string;
}

type Status = "idle" | "loading" | "valid" | "error";

export function AssetSelector({ onAssetChange, currentTicker }: AssetSelectorProps) {
  const [input,    setInput]    = useState(currentTicker);
  const [status,   setStatus]   = useState<Status>("idle");
  const [message,  setMessage]  = useState("");
  const [assetInfo, setAssetInfo] = useState<AssetInfo | null>(null);
  const [recent,   setRecent]   = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  async function validate(ticker: string) {
    const t = ticker.trim().toUpperCase();
    if (!t) return;

    setStatus("loading");
    setMessage("");

    try {
      const info = await validateTicker(t);
      setAssetInfo(info);
      setStatus("valid");
      setMessage(`${info.name} · ${info.sector} · $${info.currentPrice.toFixed(2)}`);
      saveRecent(t);
      setRecent(loadRecent());
      onAssetChange(t, info);
    } catch (e: unknown) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Ticker not found");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    validate(input);
  }

  function handlePreset(ticker: string) {
    setInput(ticker);
    validate(ticker);
  }

  function handleClear() {
    setInput("");
    setStatus("idle");
    setMessage("");
    setAssetInfo(null);
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="Enter ticker (e.g. AAPL, SPY, XLF)"
            className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {input && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="submit" disabled={status === "loading"} size="sm" className="h-10">
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Go"}
        </Button>
      </form>

      {/* Validation feedback */}
      {status !== "idle" && (
        <div className={`flex items-center gap-2 text-sm ${status === "error" ? "text-red-600" : status === "valid" ? "text-green-700" : "text-muted-foreground"}`}>
          {status === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "valid"   && <CheckCircle2 className="h-3 w-3" />}
          {status === "error"   && <AlertCircle  className="h-3 w-3" />}
          <span className="truncate">{message}</span>
          {assetInfo && (
            <Badge variant={assetInfo.assetClass === "etf" ? "success" : "muted"} className="ml-auto shrink-0">
              {assetInfo.assetClass.toUpperCase()}
            </Badge>
          )}
        </div>
      )}

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-1.5">
        <span className="self-center text-xs text-muted-foreground">Quick:</span>
        {PRESET_TICKERS.map((t) => (
          <button
            key={t}
            onClick={() => handlePreset(t)}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              currentTicker === t
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-accent"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Recent tickers */}
      {recent.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="self-center text-xs text-muted-foreground">Recent:</span>
          {recent
            .filter((t) => !PRESET_TICKERS.includes(t))
            .map((t) => (
              <button
                key={t}
                onClick={() => handlePreset(t)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  currentTicker === t
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-accent"
                }`}
              >
                {t}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
