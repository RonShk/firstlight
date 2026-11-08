"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClaimView } from "@/types/claims";
import { ClaimDetail } from "./claim-detail";
import { ClaimList, NO_FILTERS, PAGE_SIZE, type ClaimFilters } from "./claim-list";
import { useClaims } from "./claims-provider";
import { ConversationDrawer } from "./conversation-drawer";
import { PolicyDocumentsViewer } from "./policy-documents-viewer";

function matchesSearch(c: ClaimView, q: string): boolean {
  return [c.persona.name, c.number, c.subject, ...c.body].some((s) => s.toLowerCase().includes(q));
}

export function ClaimsWorkspace() {
  const { claims, isAssigned, markRead, requestReview } = useClaims();
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ClaimFilters>(NO_FILTERS);
  const [page, setPage] = useState(0);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [docsTarget, setDocsTarget] = useState<{ docId?: string; page?: number | null } | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return claims.filter(
      (c) =>
        (!q || matchesSearch(c, q)) &&
        (!filters.severities.length || filters.severities.includes(c.review.severity)) &&
        (!filters.lines.length || filters.lines.some((l) => c.review.lines.includes(l))) &&
        (filters.assignment === "all" || (filters.assignment === "mine") === isAssigned(c.id)),
    );
  }, [claims, search, filters, isAssigned]);

  const selected = visible.find((c) => c.id === selectedId) ?? visible[0];
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);

  // Whichever claim is on screen gets a real Nemotron review. The queue skips ones it has seen.
  useEffect(() => {
    if (selected) requestReview(selected);
  }, [selected?.id, requestReview]); // eslint-disable-line react-hooks/exhaustive-deps -- re-run per claim, not per re-sort

  return (
    <div className="flex min-h-0 flex-1">
      <ClaimList
        claims={visible}
        selectedId={selected?.id}
        onSelect={(id) => {
          setSelectedId(id);
          markRead(id);
        }}
        search={search}
        onSearch={(value) => {
          setSearch(value);
          setPage(0);
        }}
        filters={filters}
        onFilters={(value) => {
          setFilters(value);
          setPage(0);
        }}
        page={Math.min(page, lastPage)}
        onPage={setPage}
      />
      <main className="thin-scroll min-w-0 flex-1 overflow-y-auto bg-white">
        {selected ? (
          <ClaimDetail key={selected.id} claim={selected} onConversation={() => setConversationOpen(true)} onDocuments={(docId, docPage) => setDocsTarget({ docId, page: docPage })} />
        ) : (
          <p className="p-9 text-[16px] text-subtle">No claims match your search.</p>
        )}
      </main>
      {selected ? (
        <>
          <ConversationDrawer key={selected.id} claim={selected} open={conversationOpen} onOpenChange={setConversationOpen} />
          <PolicyDocumentsViewer persona={selected.persona} documents={selected.documents} target={docsTarget} onClose={() => setDocsTarget(null)} />
        </>
      ) : null}
    </div>
  );
}
