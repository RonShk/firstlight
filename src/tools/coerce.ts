// Tool-calling models produce imperfect JSON: nested arrays encoded as strings ({"findings": "[{...}]"}),
// junk after the object ("{...}{}{}"), or output cut off mid-object. These helpers recover the intended
// value where that is unambiguous; anything else still fails validation and is reported to the model.

/** Index just past the first balanced JSON object/array starting at `start`, or -1 if unterminated. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { if (--depth === 0) return i + 1; }
  }
  return -1;
}

/** Close an output that was cut off: terminate an open string, drop a dangling key/comma, close brackets. */
function closeTruncated(text: string): string {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (ch === "\\") i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = inString ? `${text}"` : text;
  out = out.replace(/,\s*$/, "").replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  return out + stack.reverse().join("");
}

/** Parse JSON text leniently: exact, else the first balanced value, else a repaired truncated value. */
export function parseLenient(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start < 0) throw new SyntaxError("No JSON object found");
  const end = balancedEnd(t, start);
  if (end > 0) return JSON.parse(t.slice(start, end));
  return JSON.parse(closeTruncated(t.slice(start)));
}

export function decodeNestedJson(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try { return decodeNestedJson(parseLenient(t), depth + 1); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => decodeNestedJson(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeNestedJson(v, depth + 1)]));
  }
  return value;
}

/** Parse tool-call arguments leniently and decode nested JSON strings. Throws only when nothing is recoverable. */
export function parseArguments(raw: string): unknown {
  return decodeNestedJson(raw?.trim() ? parseLenient(raw) : {});
}
