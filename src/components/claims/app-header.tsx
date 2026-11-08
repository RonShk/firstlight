"use client";

import Image from "next/image";
import { ADJUSTER } from "./claims-provider";

export function AppHeader() {
  return <header className="flex h-[62px] shrink-0 items-center justify-between border-b border-line bg-white px-6">
    <div className="flex items-center gap-4"><Image src="/state-farm-logo.png" alt="State Farm" width={160} height={28} priority /><span className="h-6 w-px bg-line" /><span className="text-sm text-subtle">Catastrophe response</span></div>
    <div className="flex items-center gap-5"><span className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-soft text-xs font-semibold">JS</span><span className="text-sm">{ADJUSTER}</span></span></div>
  </header>;
}
