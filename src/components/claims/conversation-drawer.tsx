"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ClaimMessage, ClaimView } from "@/types/claims";
import { ageLabel, dayLabel } from "@/lib/claims/format";
import { ADJUSTER, useClaims } from "./claims-provider";

const when = (m: ClaimMessage) => (m.minutesAgo < 1 ? "just now" : `${ageLabel(m.minutesAgo)} ago`);

function Bubble({ message, name }: { message: ClaimMessage; name: string }) {
  if (message.from === "note") return <p className="px-4 text-center text-[13.5px] text-subtle">{message.text}</p>;
  const ours = message.from !== "policyholder";
  const author = message.from === "policyholder" ? name : message.from === "adjuster" ? ADJUSTER : "State Farm automated reply";
  return (
    <div className={ours ? "ml-auto w-fit max-w-[85%]" : "w-fit max-w-[85%]"}>
      <p className={`text-[13.5px] text-subtle ${ours ? "text-right" : ""}`}>{author} · {when(message)}</p>
      <p className={`mt-1.5 rounded-[14px] px-3.5 py-2.5 text-[15px] leading-[23px] whitespace-pre-wrap text-ink ${ours ? "bg-critical-soft" : "bg-soft"}`}>{message.text}</p>
    </div>
  );
}

interface ConversationDrawerProps {
  claim: ClaimView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConversationDrawer({ claim, open, onOpenChange }: ConversationDrawerProps) {
  const { threadFor, sendReply } = useClaims();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const thread = threadFor(claim);
  const count = thread.filter((m) => m.from !== "note").length;
  const canSend = draft.trim().length > 0;

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, count]);

  const send = () => {
    if (!canSend) return;
    sendReply(claim.id, draft.trim());
    setDraft("");
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup initialFocus={inputRef} className="fixed inset-y-0 right-0 z-50 flex w-[436px] max-w-full flex-col bg-white shadow-xl outline-none transition-transform duration-200 data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full">
          <div className="flex items-start justify-between gap-4 border-b border-line px-[22px] pt-[20px] pb-[16px]">
            <div className="min-w-0">
              <Dialog.Title className="text-[18px] font-semibold text-ink">Claim Conversation</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-[14px] text-subtle">{claim.persona.name} · Claim {claim.number} · {count} {count === 1 ? "message" : "messages"}</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="cursor-pointer text-ink-2 hover:text-ink"><X className="size-5" strokeWidth={1.5} /></Dialog.Close>
          </div>

          <div className="thin-scroll min-h-0 flex-1 space-y-[22px] overflow-y-auto px-[22px] py-[22px]">
            {thread.map((m, i) => {
              const day = dayLabel(m.minutesAgo);
              return (
                <Fragment key={m.id}>
                  {i === 0 || dayLabel(thread[i - 1].minutesAgo) !== day ? (
                    <div className="flex items-center gap-3 text-[13.5px] text-subtle">
                      <span className="h-px flex-1 bg-line" />{day}<span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                  <Bubble message={m} name={claim.persona.name} />
                </Fragment>
              );
            })}
            <div ref={endRef} />
          </div>

          <div className="border-t border-line px-[22px] pt-[18px] pb-[18px]">
            <label htmlFor="reply" className="text-[14px] text-subtle">Reply to {claim.persona.name}</label>
            <textarea
              id="reply"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={3}
              placeholder="Write a reply"
              className="mt-2.5 w-full resize-none rounded-[12px] bg-soft px-3.5 py-2.5 text-[15.5px] text-ink outline-none placeholder:text-subtle"
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[13.5px] text-subtle">Shift + Enter for a new line</span>
              <button type="button" disabled={!canSend} onClick={send} className="h-[38px] cursor-pointer rounded-full bg-brand px-[23px] text-[16px] font-semibold text-white hover:bg-brand-dark disabled:cursor-default disabled:bg-[#efb3b8]">Send reply</button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
