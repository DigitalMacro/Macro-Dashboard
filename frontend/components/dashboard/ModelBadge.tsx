import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface ModelBadgeProps {
  rsquared?: number;
  nObs?: number;
}

export function ModelBadge({ rsquared, nObs }: ModelBadgeProps) {
  const quality =
    rsquared == null ? "muted"
    : rsquared > 0.5 ? "success"
    : rsquared > 0.2 ? "warning"
    : "destructive";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 cursor-default">
            <Badge variant={quality as "muted" | "success" | "warning" | "destructive"}>
              MFERM · PLSR
            </Badge>
            {rsquared != null && (
              <span className="text-xs text-muted-foreground">
                R² {(rsquared * 100).toFixed(1)}%
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">QI_US_MACRO_MT_1 — Partial Least Squares Regression</p>
          {nObs && <p className="text-xs">Window: {nObs} trading days</p>}
          {rsquared != null && (
            <p className="text-xs">
              In-sample R²: {(rsquared * 100).toFixed(1)}%
              {rsquared < 0.2 && " (low confidence — use with caution)"}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
