// Content-safety screening with NVIDIA's Nemotron Safety Guard. Inbound text is screened and the result
// recorded (a flag is passed to the agent as context; disaster reports legitimately mention injury).
// Outbound replies flagged unsafe are held for a human instead of being sent.
import { config, type Config } from "../config";
import { postNvidia } from "../knowledge/embeddings";

export interface Screen {
  safe: boolean;
  categories: string[];
  model: string;
}

export interface Guard {
  model: string;
  screen(customerText: string, reply?: string, signal?: AbortSignal): Promise<Screen>;
}

export function nemotronGuard(c: Config = config()): Guard | null {
  if (!c.guard) return null;
  const { baseUrl, model } = c.guard;
  return {
    model,
    async screen(customerText, reply, signal) {
      const messages = [{ role: "user", content: customerText.slice(0, 6_000) }, ...(reply ? [{ role: "assistant", content: reply }] : [])];
      const out = (await postNvidia(`${baseUrl}/chat/completions`, c.nvidiaKey, { model, messages, max_tokens: 120, temperature: 0 }, signal, 2)) as
        { choices?: { message?: { content?: string } }[] };
      const text = out.choices?.[0]?.message?.content ?? "";
      const parsed = parseVerdict(text);
      const verdict = reply ? parsed["Response Safety"] : parsed["User Safety"];
      if (!verdict) throw new Error(`Unrecognized guard output: ${text.slice(0, 120)}`);
      return { safe: verdict.toLowerCase() !== "unsafe", categories: String(parsed["Safety Categories"] ?? "").split(",").map((s) => s.trim()).filter(Boolean), model };
    },
  };
}

function parseVerdict(text: string): Record<string, string> {
  try {
    const start = text.indexOf("{");
    return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  } catch {
    return {};
  }
}
