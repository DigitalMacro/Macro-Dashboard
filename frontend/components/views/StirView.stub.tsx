// Build-time stand-in for StirView.tsx, swapped in by next.config.mjs's
// webpack alias when NEXT_PUBLIC_ENABLE_STIR is unset. Never actually
// renders — both call sites (app/stir/page.tsx, app/page.tsx) call
// notFound()/skip the tab before this would mount — but it exists so the
// aliased import path still resolves to something. Keeps the real
// StirView.tsx (and its recharts/CME-symbol code) out of the bundle
// entirely rather than merely unrendered.

export function StirView() {
  return null;
}
