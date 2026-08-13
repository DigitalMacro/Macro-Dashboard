"use client";

// STIR module route — thin wrapper around the existing StirView (unchanged).
import { notFound } from "next/navigation";
import { StirView } from "@/components/views/StirView";

const STIR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_STIR === "true";

export default function StirPage() {
  if (!STIR_ENABLED) {
    notFound();
    // Unreachable at runtime (notFound() throws) — but an explicit return
    // here, rather than falling through to the JSX below, is what lets the
    // minifier prove the heavy branch is dead once STIR_ENABLED folds to a
    // literal false at build time. Terser can eliminate "if (true) {...
    // return} return X" as ordinary control flow; it can't infer that
    // notFound() itself never returns.
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <div className="mb-4">
          <h1 className="text-base font-bold leading-none">STIR</h1>
          <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
            Short-Term Interest Rate Futures
          </p>
        </div>
        <StirView />
      </main>
    </div>
  );
}
