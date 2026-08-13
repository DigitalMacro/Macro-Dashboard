import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { PROXY_FIDELITY, PROXY_SOURCE } from "@/lib/constants";

interface FidelityBadgeProps {
  factor: string;
}

const FIDELITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  perfect: { bg: "bg-green-100",  text: "text-green-800",  label: "Perfect" },
  high:    { bg: "bg-blue-100",   text: "text-blue-800",   label: "High" },
  medium:  { bg: "bg-amber-100",  text: "text-amber-800",  label: "Medium" },
};

export function FidelityBadge({ factor }: FidelityBadgeProps) {
  const fidelity = PROXY_FIDELITY[factor];
  const source   = PROXY_SOURCE[factor];
  if (!fidelity) return null;

  const style = FIDELITY_STYLES[fidelity] ?? FIDELITY_STYLES.medium;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium cursor-default ${style.bg} ${style.text}`}
          >
            {style.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs font-medium">Proxy fidelity: {style.label}</p>
          {source && <p className="text-xs text-muted-foreground">{source}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
