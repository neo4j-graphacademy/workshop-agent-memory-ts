// STAGE 2: context traces. Two parts:
//   ContextRecorder (input processor) sees exactly what is about to be sent to the model at every step and writes it as a graph:
//       (:Message)-[:NEXT]->(:Message)                          conversation order
//       (:Message)-[:MADE_CALL]->(:ToolCall {args, arg_<name>, result, outcome})-[:OF_TOOL]->(:Tool)   one per tool call in an assistant message
//       (:SystemMessage)  one per injected system block (instructions, pinned rules, what is known about the user)
//           -[:PINS]->(:Rule)  -[:RETRIEVED {score}]->(:Email|:Event|:Issue|:Person)  -[:ADDED_FOR]->(:Message)
//   recordStep      (onStepFinish)    writes the Step node (one per model step) with (Step)-[:HAD_IN_CONTEXT]->(Message|SystemMessage),
//                                     (Step)-[:REQUESTED]->(ToolCall), (Step)-[:NEXT]->(Step) and (ToolCall)-[:NEXT]->(ToolCall)
import { createHash } from "node:crypto";
import type { Processor, ProcessInputStepArgs } from "@mastra/core/processors";
import { config } from "../../../workshop.config.js";
import { upsertSession, writeConversation, writeStep, writeSystemMessages, type SystemMessageRow, type ToolCallRow } from "../graph/store.js";
import { messageText } from "../processors/util.js";
import { runtime } from "../runtime.js";
import { specs } from "../tools/index.js";

const clip = (s: string, n = 1000) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("\n") : "";

/** Tool calls inside an assistant message. Args become properties: `args` (JSON) and `arg_<name>`. */
export function toolCallRow(c: { id: string; tool: string; args: unknown; result?: any; state?: string; messageId?: string; position?: number }): ToolCallRow {
  const outcome = c.result === undefined ? "pending" : c.result?.status ? String(c.result.status) : c.result?.error ? "error" : "ok";
  const props: ToolCallRow["props"] = {
    args: JSON.stringify(c.args ?? {}),
    outcome,
    ...(c.state ? { state: c.state } : {}),
    ...(c.result !== undefined ? { result: clip(JSON.stringify(c.result)) } : {}),
  };
  for (const [k, v] of Object.entries((c.args ?? {}) as Record<string, unknown>)) {
    if (["string", "number", "boolean"].includes(typeof v)) props[`arg_${k}`] = v as string | number | boolean;
  }
  const spec = (specs as Record<string, { write: boolean; description: string }>)[c.tool];
  return { id: c.id, tool: c.tool, messageId: c.messageId, position: c.position, props, write: spec?.write ?? false, description: spec?.description ?? "" };
}

function toolCallsOf(m: any): ToolCallRow[] {
  const rows: ToolCallRow[] = [];
  let position = 0;
  for (const part of (m.content?.parts ?? []) as any[]) {
    if (part.type !== "tool-invocation") continue;
    const t = part.toolInvocation ?? {};
    const result = t.state === "result" ? t.result : undefined;
    rows.push(toolCallRow({ id: String(t.toolCallId), tool: String(t.toolName), args: t.args, result, state: String(t.state ?? ""), messageId: m.id, position: position++ }));
  }
  return rows;
}

const KIND_BY_TAG: Record<string, string> = { "pinned-rules": "pinned_rules", "about-user": "about_user" };

function systemRows(messageList: ProcessInputStepArgs["messageList"]): SystemMessageRow[] {
  const rows: SystemMessageRow[] = [];
  const add = (kind: string, text: string, meta: { rules?: string[] } = {}) => {
    if (!text.trim()) return;
    rows.push({ id: createHash("sha1").update(`${kind}\n${text}`).digest("hex").slice(0, 12), kind, text, ...meta });
  };
  for (const m of messageList.getSystemMessages()) add("instructions", textOf((m as any).content));
  for (const [tag, kind] of Object.entries(KIND_BY_TAG)) {
    for (const m of messageList.getSystemMessages(tag)) add(kind, textOf((m as any).content), runtime.systemMeta[tag]);
  }
  return rows;
}

export class ContextRecorder implements Processor {
  id = "context-recorder";
  async processInputStep({ messageList }: ProcessInputStepArgs) {
    if (!config.traces) return;
    const all = messageList.get.all.db();
    // Assign the user turn each message belongs to, the first time we see it.
    let prev = 0;
    for (const m of all) {
      if (!runtime.turnOf.has(m.id)) {
        runtime.turnOf.set(m.id, m.id === runtime.userMessageId ? runtime.turn : m.role === "user" ? prev + 1 : prev || runtime.turn);
      }
      prev = runtime.turnOf.get(m.id)!;
    }
    await upsertSession(runtime.sessionId);
    await writeConversation(
      all.map((m) => ({ id: m.id, role: m.role, text: messageText(m), turn: runtime.turnOf.get(m.id) ?? 0 })),
      runtime.sessionId,
      all.flatMap(toolCallsOf),
    );
    const sys = systemRows(messageList);
    await writeSystemMessages(sys, runtime.userMessageId);
    runtime.pendingContexts.push({ messageIds: all.map((m) => m.id), systemMessageIds: sys.map((s) => s.id) });
    return;
  }
}

/** onStepFinish: one Step per model step, plus a ToolCall node for each call it requested. */
export async function recordStep(step: any): Promise<void> {
  if (!config.traces) return;
  const ctx = runtime.pendingContexts.shift() ?? { messageIds: [], systemMessageIds: [] };
  const results: any[] = step.toolResults ?? [];
  const calls: ToolCallRow[] = (step.toolCalls ?? []).map((call: any, i: number) => {
    const p = call.payload ?? call;
    const res = results.find((r) => (r.payload ?? r).toolCallId === p.toolCallId);
    return toolCallRow({ id: String(p.toolCallId), tool: p.toolName, args: p.args, result: res ? (res.payload ?? res).result : undefined, position: i });
  });
  const n = ++runtime.step;
  await writeStep({
    sessionId: runtime.sessionId, n, finishReason: step.finishReason, text: step.text,
    messageIds: ctx.messageIds, systemMessageIds: ctx.systemMessageIds,
    calls, prevToolCallId: runtime.lastToolCallId,
  });
  if (calls.length) runtime.lastToolCallId = calls[calls.length - 1].id;
}
