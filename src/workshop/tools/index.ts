// Turns ToolSpecs into Mastra tools. Every call is audited; writes go through the MODE switch.
import { createTool } from "@mastra/core/tools";
import { config } from "../../../workshop.config.js";
import { appendAudit } from "../nsuite/audit.js";
import { delete_email, list_emails, read_email, send_message } from "./mail.js";
import { get_events, update_event } from "./calendar.js";
import { get_issue, list_issues, update_issue } from "./tickets.js";
import { query_memory, remember_fact, show_extraction_prompt } from "./memory.js";
import { explore_graph, query_graph } from "./graph.js";
import { search_emails } from "./search.js";
import { runGuards } from "./guards.js";
import type { ToolSpec } from "./spec.js";

/** Run a spec honouring workshop.config.ts `mode`. Exported for tests. */
export async function execute(s: ToolSpec<any>, args: any): Promise<{ result: unknown; outcome: string }> {
  try {
    if (!s.write) {
      const useReal = config.mode === "real" && process.env.REAL_READS === "1" && s.real;
      return { result: await (useReal ? s.real!(args) : s.mock(args)), outcome: "ok" };
    }
    switch (config.mode) {
      case "dry-run":
        return { result: s.dryRun ? s.dryRun(args) : { ok: true, dryRun: true, ...args }, outcome: "dry-run" };
      case "real":
        return { result: await (s.real ?? s.mock)(args), outcome: "ok" };
      default:
        return { result: await s.mock(args), outcome: "ok" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: { error: message }, outcome: "error" };
  }
}

export function toMastraTool(s: ToolSpec<any>) {
  return createTool({
    id: s.id,
    description: s.description,
    inputSchema: s.schema,
    execute: async (args: any) => {
      // STAGE 5: guards run before anything else, and a blocked call is still audited.
      const block = await runGuards({ tool: s.id, args });
      if (block) {
        appendAudit({ tool: s.id, args, write: s.write, mode: config.mode, outcome: `blocked:${block.gate}` });
        return block as any;
      }
      const { result, outcome } = await execute(s, args);
      appendAudit({ tool: s.id, args, write: s.write, mode: config.mode, outcome });
      return result as any;
    },
  });
}

export const specs = { list_emails, read_email, delete_email, send_message, get_events, update_event, list_issues, get_issue, update_issue, remember_fact, query_memory, show_extraction_prompt, query_graph, explore_graph, search_emails };

/** Everyday tools (mail, calendar, tickets). */
export const baseTools = Object.fromEntries(
  [list_emails, read_email, delete_email, send_message, get_events, update_event, list_issues, get_issue, update_issue].map((s) => [s.id, toMastraTool(s)]),
);
/** Long-term memory tools (STAGE 3). */
export const memoryTools = { remember_fact: toMastraTool(remember_fact), query_memory: toMastraTool(query_memory), show_extraction_prompt: toMastraTool(show_extraction_prompt) };
/** Retrieval tools (STAGE 4). The `retrieval` setting in workshop.config.ts decides which of them the agent gets. */
export const retrievalTools = {
  search_emails: toMastraTool(search_emails),
  explore_graph: toMastraTool(explore_graph),
  query_graph: toMastraTool(query_graph),
};
