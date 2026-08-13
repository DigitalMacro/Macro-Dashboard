import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  positive?: boolean | null;  // null = neutral
  className?: string;
}

export function MetricCard({ title, value, subtitle, positive, className }: MetricCardProps) {
  const valueColour =
    positive === null || positive === undefined
      ? "text-foreground"
      : positive
      ? "text-green-600"
      : "text-red-600";

  return (
    <Card className={cn("min-w-0", className)}>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className={cn("mt-1 text-2xl font-bold tabular-nums", valueColour)}>{value}</p>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

export function MetricCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-8 w-32 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}
