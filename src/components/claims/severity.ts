import type { Severity } from "@/types/claims";

export const SEVERITY_META: Record<Severity, { label: string; dot: string; chip: string }> = {
  critical: { label: "Critical", dot: "bg-critical", chip: "bg-critical-soft text-critical-ink" },
  high: { label: "High", dot: "bg-high", chip: "bg-high-soft text-high-ink" },
  medium: { label: "Medium", dot: "bg-medium", chip: "bg-medium-soft text-medium-ink" },
  low: { label: "Low", dot: "bg-emerald-600", chip: "bg-emerald-50 text-emerald-800" },
};
