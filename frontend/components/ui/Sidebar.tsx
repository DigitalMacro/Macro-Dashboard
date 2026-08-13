"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  comingSoon?: boolean;
}

const STIR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_STIR === "true";

const NAV_ITEMS: NavItem[] = [
  ...(STIR_ENABLED ? [{ label: "STIR", href: "/stir" }] : []),
  { label: "MFERM", href: "/mferm" },
  { label: "Rate Decomp", href: "/rate-decomp" },
  { label: "Yield Curve", href: "/yield-curve" },
  { label: "Global Rates", href: "/global-rates" },
  { label: "Cross-Asset", href: "/cross-asset" },
  { label: "FX", href: "/fx" },
  { label: "Regime Matrix", href: "/regime" },
  { label: "Portfolio", href: "/portfolio" },
  { label: "Equities", href: "/equities", comingSoon: true },
  { label: "Calendar", href: "/calendar", comingSoon: true },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-48 shrink-0 min-h-screen bg-[#0a0a0d] border-r border-white/[0.07] flex flex-col">
      <div className="px-4 py-5 border-b border-white/[0.07]">
        <p className="text-sm font-semibold text-[#F0F0F0] tracking-tight">MFERM</p>
        <p className="text-[10px] font-mono tracking-widest uppercase text-neutral-600 mt-0.5">
          Macro Dashboard
        </p>
      </div>

      <nav className="flex-1 py-3">
        {NAV_ITEMS.map((item) => {
          if (item.comingSoon) {
            return (
              <div
                key={item.href}
                className="flex items-center justify-between px-4 py-2.5 text-xs font-mono tracking-wider uppercase cursor-not-allowed select-none"
                style={{ color: "#374151", borderLeft: "2px solid transparent" }}
              >
                {item.label}
                <span className="text-[9px] font-mono tracking-widest px-1.5 py-0.5 rounded border border-neutral-800 text-neutral-700">
                  SOON
                </span>
              </div>
            );
          }

          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center px-4 py-2.5 text-xs font-mono tracking-wider uppercase transition-colors hover:text-neutral-300"
              style={
                active
                  ? {
                      background: "rgba(245,158,11,0.12)",
                      color: "#f59e0b",
                      borderLeft: "2px solid #f59e0b",
                    }
                  : { color: "#6b7280", borderLeft: "2px solid transparent" }
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-white/[0.07]">
        <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
          LIVE
        </span>
      </div>
    </aside>
  );
}
