import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPct(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

export function formatBp(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}bp`;
}

export function getDateRangeDates(range: string): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().split("T")[0];
  let start: Date;

  switch (range) {
    case "1M":
      start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      break;
    case "3M":
      start = new Date(now);
      start.setMonth(start.getMonth() - 3);
      break;
    case "6M":
      start = new Date(now);
      start.setMonth(start.getMonth() - 6);
      break;
    case "YTD":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "1Y":
    default:
      start = new Date(now);
      start.setFullYear(start.getFullYear() - 1);
  }

  return { start: start.toISOString().split("T")[0], end };
}
