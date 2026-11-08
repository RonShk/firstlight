import "server-only";
import type { Persona } from "@/types/sim";
import { composeReply, decide } from "./decide";
import { searchPolicy, type PolicyHit } from "./policy-search";
import { policyholderRecord } from "./record";
import type { AgentRequest, AgentResult, AgentStep, CoverageCall, CoveragePart, Extent, ModelAssessment } from "./types";

/**
 * Nemotron claims-triage agent. Talks to any OpenAI-compatible endpoint:
 * NVIDIA's hosted API (build.nvidia.com) or a vLLM/NIM server on Brev.
 */

const MAX_STEPS = 6;

export function agentConfig() {
  const baseUrl = (process.env.NEMOTRON_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const apiKey = process.env.NEMOTRON_API_KEY || "";
  const model = process.env.NEMOTRON_MODEL || "";
  const hosted = baseUrl.includes("api.nvidia.com");
  return { baseUrl, apiKey, model, configured: !!model && (!hosted || !!apiKey) };
}

const SYSTEM_PROMPT = `You are State Farm's catastrophe claims triage agent. A tornado just hit the Oklahoma City metro. You read a policyholder's text messages and their policy file, then assess the situation.

Process:
1. Read every message carefully. People downplay emergencies, bury the urgent part, use slang and typos, or say almost nothing.
2. For each loss they describe, call search_policy to find the relevant language in THIS policyholder's policy forms (for example: "windstorm dwelling", "additional living expense", "comprehensive collision vehicle", "personal property"). Only cite text that search_policy returned.
3. Call submit_assessment exactly once with your final judgment.

Severity rubric (0-100):
- 90-100: life safety. Injury, medical emergency (oxygen, dialysis, insulin, chest pain, labor, newborn without supplies), trapped or missing person.
- 70-89: home unlivable or household displaced tonight, or a vulnerable person at risk.
- 40-69: major property damage but the home is still livable.
- 15-39: minor damage.
- 0-14: safe, no damage.

Coverage values: "covered", "excluded", "unclear" (the message doesn't say enough), "no_policy" (they have no policy for that line, e.g. a renter with no renters/home policy).
Extent values: "minor", "moderate", "severe", "total".
coverage_part values: "dwelling", "other_structures", "personal_property", "loss_of_use", "vehicle", "liability", "other". Displaced households should get a loss_of_use item.

Rules:
- Never state or estimate dollar amounts. Code computes money from the policy limits.
- If the message is too vague to assess, set confidence below 0.5 and ask one short follow-up question.
- reply_text: warm, plain, under 280 characters, written to the policyholder. Do not promise amounts or approval. If anyone is hurt or has a medical emergency, tell them to call 911.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_policy",
      description: "Search this policyholder's own policy forms for coverage language. Returns the most relevant passages with their doc_id and section.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, e.g. 'windstorm damage to dwelling' or 'additional living expense'." },
          line: { type: "string", enum: ["home", "auto", "umbrella"], description: "Optionally limit to one line of coverage." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_assessment",
      description: "Submit the final assessment. Call exactly once, after searching the policy.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One or two sentences: what happened to this household." },
          safety: {
            type: "object",
            properties: {
              injury_reported: { type: "boolean" },
              medical_urgent: { type: "boolean" },
              displaced: { type: "boolean" },
              trapped_or_missing: { type: "boolean" },
            },
            required: ["injury_reported", "medical_urgent", "displaced", "trapped_or_missing"],
          },
          severity: { type: "integer", minimum: 0, maximum: 100 },
          severity_reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line: { type: "string", enum: ["home", "auto", "umbrella", "none"] },
                coverage_part: { type: "string", enum: ["dwelling", "other_structures", "personal_property", "loss_of_use", "vehicle", "liability", "other"] },
                item: { type: "string", description: "Short description, e.g. 'Roof and bedroom walls' or '2022 Lexus RX 350'." },
                extent: { type: "string", enum: ["minor", "moderate", "severe", "total"] },
                coverage: { type: "string", enum: ["covered", "excluded", "unclear", "no_policy"] },
                citation_doc_id: { type: ["string", "null"] },
                citation_quote: { type: ["string", "null"], description: "Short exact quote from a search_policy result." },
                reasoning: { type: "string" },
              },
              required: ["line", "coverage_part", "item", "extent", "coverage", "reasoning"],
            },
          },
          needs: { type: "array", items: { type: "string" }, description: "Immediate needs, e.g. shelter, medical, power for oxygen." },
          reply_text: { type: "string" },
          follow_up_question: { type: ["string", "null"] },
        },
        required: ["summary", "safety", "severity", "severity_reason", "confidence", "claims", "needs", "reply_text"],
      },
    },
  },
];

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const normalizeText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Validate the model's JSON, clamp numbers, and drop citations it didn't actually retrieve. */
function sanitize(raw: Record<string, unknown>, retrieved: PolicyHit[], docIds: string[]): ModelAssessment {
  const safety = (raw.safety ?? {}) as Record<string, unknown>;
  const claims = Array.isArray(raw.claims) ? (raw.claims as Record<string, unknown>[]) : [];
  const corpus = retrieved.map((h) => ({ docId: h.docId, text: normalizeText(h.text) }));
  return {
    summary: String(raw.summary ?? ""),
    safety: {
      injury_reported: !!safety.injury_reported,
      medical_urgent: !!safety.medical_urgent,
      displaced: !!safety.displaced,
      trapped_or_missing: !!safety.trapped_or_missing,
    },
    severity: Math.max(0, Math.min(100, Math.round(Number(raw.severity) || 0))),
    severity_reason: String(raw.severity_reason ?? ""),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    claims: claims.map((c) => {
      const docId = typeof c.citation_doc_id === "string" ? c.citation_doc_id : null;
      const quote = typeof c.citation_quote === "string" ? c.citation_quote : null;
      const nq = quote ? normalizeText(quote).slice(0, 120) : "";
      const verified = !!docId && !!quote && docIds.includes(docId) && nq.length > 8 && corpus.some((h) => h.docId === docId && h.text.includes(nq));
      return {
        line: pickEnum(c.line, ["home", "auto", "umbrella", "none"] as const, "none"),
        coverage_part: pickEnum<CoveragePart>(c.coverage_part, ["dwelling", "other_structures", "personal_property", "loss_of_use", "vehicle", "liability", "other"], "other"),
        item: String(c.item ?? "Unspecified loss"),
        extent: pickEnum<Extent>(c.extent, ["minor", "moderate", "severe", "total"], "moderate"),
        coverage: pickEnum<CoverageCall>(c.coverage, ["covered", "excluded", "unclear", "no_policy"], "unclear"),
        citation_doc_id: verified ? docId : null,
        citation_quote: verified ? quote : null,
        reasoning: String(c.reasoning ?? ""),
      };
    }),
    needs: Array.isArray(raw.needs) ? raw.needs.map(String) : [],
    reply_text: String(raw.reply_text ?? "We got your message and we're on it."),
    follow_up_question: typeof raw.follow_up_question === "string" && raw.follow_up_question.trim() ? raw.follow_up_question : null,
  };
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const match = stripThinking(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function chat(messages: ChatMessage[], forceSubmit: boolean) {
  const { baseUrl, apiKey, model } = agentConfig();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: forceSubmit ? { type: "function", function: { name: "submit_assessment" } } : "auto",
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) throw new Error(`Nemotron ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message as { content: string | null; tool_calls?: ToolCall[] };
}

export async function runAgent(persona: Persona, req: AgentRequest): Promise<AgentResult> {
  const started = Date.now();
  const record = policyholderRecord(persona);
  const docIds = persona.policies.map((p) => p.formId);
  const steps: AgentStep[] = [];
  const retrieved: PolicyHit[] = [];

  const transcript = req.conversation.map((m) => `${m.from === "policyholder" ? persona.name.split(" ")[0] : "State Farm"}: ${m.text}`).join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Policyholder file:\n${JSON.stringify(record, null, 2)}\n\nConversation:\n${transcript}\n\nAssess this household. Search the policy, then call submit_assessment.` },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = Date.now();
    const msg = await chat(messages, step === MAX_STEPS - 1);
    steps.push({ kind: "model", name: "nemotron", detail: msg.tool_calls?.length ? `requested ${msg.tool_calls.map((t) => t.function.name).join(", ")}` : "replied", ms: Date.now() - t0 });

    if (!msg.tool_calls?.length) {
      const loose = msg.content ? parseJsonLoose(msg.content) : null;
      if (loose && "severity" in loose) return finish(sanitize(loose, retrieved, docIds));
      messages.push({ role: "assistant", content: msg.content ?? "" });
      messages.push({ role: "user", content: "Call submit_assessment now with your final assessment." });
      continue;
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* handled below */
      }
      if (call.function.name === "submit_assessment") return finish(sanitize(args, retrieved, docIds));
      if (call.function.name === "search_policy") {
        const t1 = Date.now();
        const line = typeof args.line === "string" ? args.line : null;
        const scope = line ? persona.policies.filter((p) => p.line === line).map((p) => p.formId) : docIds;
        const hits = searchPolicy(String(args.query ?? ""), scope.length ? scope : docIds);
        retrieved.push(...hits);
        steps.push({ kind: "tool", name: "search_policy", detail: `"${args.query}"${line ? ` (${line})` : ""} → ${hits.map((h) => `${h.docId} · ${h.section}`).join("; ") || "no matches"}`, ms: Date.now() - t1 });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(hits.length ? hits.map((h) => ({ doc_id: h.docId, section: h.section, page: h.page, text: h.text.slice(0, 700) })) : { result: "No matching language in this policyholder's forms." }),
        });
      } else {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool ${call.function.name}` }) });
      }
    }
  }
  throw new Error("Agent did not submit an assessment");

  function finish(assessment: ModelAssessment): AgentResult {
    const decision = decide(persona, assessment);
    steps.push({ kind: "tool", name: "decide", detail: `${decision.route} · $${decision.total.toLocaleString()} estimated · ${decision.routeReason}`, ms: 0 });
    return {
      personaId: persona.id,
      assessment,
      decision,
      reply: composeReply(persona, assessment, decision),
      steps,
      model: agentConfig().model,
      ms: Date.now() - started,
      cached: false,
    };
  }
}
