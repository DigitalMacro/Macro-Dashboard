import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STIR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_STIR === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for the Dockerfile's multi-stage build — it copies
  // .next/standalone, which only exists when this is set. Without it the
  // container build fails at COPY --from=builder /app/.next/standalone.
  output: "standalone",
  async rewrites() {
    // Evaluated server-side at request time, not inlined into the client
    // bundle, so reading NEXT_PUBLIC_API_URL here is safe and picks up
    // the real deploy target. The seven standalone module pages
    // (regime, yield-curve, portfolio, rate-decomp, global-rates,
    // cross-asset, fx) all call relative fetch("/api/...") and depend
    // entirely on this rewrite — they don't go through lib/api.ts's
    // direct-fetch pattern. Without this being dynamic, all seven would
    // have silently tried to reach localhost:8000 from Vercel's servers
    // in production.
    const backend = process.env.NEXT_PUBLIC_API_URL;
    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
    ];
  },
  webpack: (config, { webpack }) => {
    // Flag-off: swap the real StirView (and everything it pulls in —
    // lib/stirApi.ts, recharts usage, CME contract-symbol logic) for an
    // empty stub. A conditional render still bundles the component; this
    // keeps it out of the graph entirely, which is what the
    // "grep .next/ for stir/zq/sr3/cbt" check in the publish spec is
    // actually verifying.
    //
    // resolve.alias keyed on the "@/..." specifier does NOT win here —
    // Next's own tsconfig-paths resolution for "@/*" takes precedence
    // over a plain resolve.alias entry, so the real file still got
    // resolved and bundled. NormalModuleReplacementPlugin intercepts by
    // the already-resolved absolute path instead, which is reliable
    // regardless of how the specifier got resolved. Verified by grepping
    // the actual .next/ build output, not just by the config accepting
    // the change without erroring.
    if (!STIR_ENABLED) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /components[\\/]views[\\/]StirView\.tsx$/,
          path.resolve(__dirname, "components/views/StirView.stub.tsx"),
        ),
      );
    }
    return config;
  },
};

export default nextConfig;
