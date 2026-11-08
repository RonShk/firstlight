import Image from "next/image";
import { Bell, CircleHelp } from "lucide-react";
import { ADJUSTER } from "./claims-provider";

export function AppHeader() {
  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-line bg-white pr-[22px] pl-[22px]">
      <div className="flex items-center">
        <Image src="/state-farm-logo.png" alt="State Farm" width={178} height={31} priority />
        <span className="ml-4 h-[22px] w-px bg-line" />
        <span className="ml-4 text-[15px] text-subtle">Claims</span>
      </div>
      <div className="flex items-center gap-6">
        <button type="button" aria-label="Help" className="text-ink-2 hover:text-ink">
          <CircleHelp className="size-[17px]" strokeWidth={1.6} />
        </button>
        <button type="button" aria-label="Notifications" className="text-ink-2 hover:text-ink">
          <Bell className="size-[17px]" strokeWidth={1.6} />
        </button>
        <span className="flex items-center gap-2.5">
          <span className="grid size-[29px] place-items-center rounded-full bg-soft text-[12px] font-semibold text-ink">JS</span>
          <span className="text-[15px] text-ink">{ADJUSTER}</span>
        </span>
      </div>
    </header>
  );
}
