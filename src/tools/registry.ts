// Every tool the agent can use, and their model-facing (OpenAI function) definitions.
import { z } from "zod";
import type OpenAI from "openai";
import { updatePlan } from "./agent/update-plan";
import { recordFinding } from "./agent/record-finding";
import { calculateEstimate } from "./claims/calculate-estimate";
import { prepareClaim } from "./claims/prepare-claim";
import { requestHumanReview } from "./claims/request-human-review";
import { getPolicies } from "./customer/get-policies";
import { getProfile } from "./customer/get-profile";
import { getEndorsements } from "./retrieval/get-endorsements";
import { readSection } from "./retrieval/read-section";
import { searchPolicies } from "./retrieval/search-policies";
import type { ToolDefinition } from "./types";

export const TOOLS: ToolDefinition[] = [
  updatePlan, getProfile, getPolicies, searchPolicies, readSection, getEndorsements, recordFinding, calculateEstimate, prepareClaim, requestHumanReview,
];

export const toolRegistry = (tools: ToolDefinition[] = TOOLS) => new Map(tools.map((t) => [t.name, t]));

export function functionSpec(name: string, description: string, schema: z.ZodType): OpenAI.Chat.ChatCompletionTool {
  const parameters = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete parameters.$schema;
  return { type: "function", function: { name, description, parameters } };
}

export const toolSpecs = (tools: ToolDefinition[] = TOOLS) => tools.map((t) => functionSpec(t.name, t.description, t.inputSchema));
