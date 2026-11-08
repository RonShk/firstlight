import type { ClaimRoute, TriageStatus } from "../../types/sim";

export interface StatusMeta {
  label: string;
  /** Map dot color. */
  hex: string;
  dot: string;
  text: string;
  chip: string;
}

export const STATUS_META: Record<TriageStatus, StatusMeta> = {
  critical: { label: "Critical", hex: "#f43f5e", dot: "bg-rose-500", text: "text-rose-400", chip: "bg-rose-500/15 text-rose-300 ring-rose-500/30" },
  silent: { label: "Silent", hex: "#a78bfa", dot: "bg-violet-400", text: "text-violet-300", chip: "bg-violet-500/15 text-violet-300 ring-violet-500/30" },
  analyzing: { label: "Analyzing", hex: "#22d3ee", dot: "bg-cyan-400", text: "text-cyan-300", chip: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30" },
  unassessed: { label: "Unread by agent", hex: "#e2e8f0", dot: "bg-slate-200", text: "text-slate-200", chip: "bg-slate-200/10 text-slate-200 ring-slate-200/30" },
  needs_help: { label: "Needs help", hex: "#f59e0b", dot: "bg-amber-400", text: "text-amber-300", chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
  awaiting: { label: "Awaiting reply", hex: "#94a3b8", dot: "bg-slate-400", text: "text-slate-300", chip: "bg-slate-500/15 text-slate-300 ring-slate-500/30" },
  safe: { label: "Safe", hex: "#34d399", dot: "bg-emerald-400", text: "text-emerald-300", chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
  monitoring: { label: "In path", hex: "#64748b", dot: "bg-slate-500", text: "text-slate-400", chip: "bg-slate-500/10 text-slate-400 ring-slate-500/20" },
};

export const ROUTE_META: Record<ClaimRoute, { label: string; chip: string }> = {
  auto_approve: { label: "Auto-approved", chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
  human_review: { label: "Agent review", chip: "bg-sky-500/15 text-sky-300 ring-sky-500/30" },
  none: { label: "No claim", chip: "bg-slate-500/10 text-slate-400 ring-slate-500/20" },
};

export function money(n: number, compact = false): string {
  if (compact && n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (compact && n >= 10_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** "19:42" + minutes → "7:54 PM". */
export function clockLabel(touchdown: string, minutes: number): string {
  const [h, m] = touchdown.split(":").map(Number);
  const total = h * 60 + m + Math.floor(minutes);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"}`;
}

export function agoLabel(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}
