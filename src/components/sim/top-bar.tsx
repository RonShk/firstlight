"use client";

import { Bot, ShieldCheck, Tornado } from "lucide-react";
import { cn } from "@/lib/utils";
import { clockLabel } from "@/lib/sim/status";
import { TORNADO } from "@/lib/sim/scenarios";
import { useSim } from "./sim-provider";

export function TopBar() {
  const { agent } = useSim();

  return (
    <header className="sticky top-0 z-10 border-b border-white/5 bg-background/80 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-6 px-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-rose-500 to-red-700 shadow-lg shadow-rose-900/40">
            <ShieldCheck className="size-4.5 text-white" />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight">No One Left Behind</span>
            <span className="block text-[11px] text-muted-foreground">State Farm · Catastrophe response</span>
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-1.5 ring-1 ring-rose-500/20">
          <Tornado className="size-3.5 text-rose-300" />
          <span className="text-xs font-medium text-rose-200">{TORNADO.title}</span>
          <span className="text-[11px] text-rose-200/60">· touched down {clockLabel(TORNADO.touchdown, 0)}</span>
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ring-1",
              agent?.configured ? "bg-cyan-500/10 text-cyan-200 ring-cyan-500/20" : "bg-amber-500/10 text-amber-200 ring-amber-500/20",
            )}
          >
            <Bot className="size-3.5" />
            {agent === null ? "Checking agent…" : agent.configured ? `Nemotron · ${agent.model}` : "Agent offline"}
          </span>
        </div>
      </div>
    </header>
  );
}
