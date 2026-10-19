// ─────────────────────────────────────────────────────────────────────────────
// workshop.config.ts: ALL feature flags live here (the single source of truth).
//
// Flip a flag to turn a capability on or off. Presets for each stage are applied
// with `npm run step -- N` (rewrites the values below, comments are preserved).
// Keep each line in the form `key: value,` so the preset tool can rewrite it.
// ─────────────────────────────────────────────────────────────────────────────

export type RetrievalMode = "none" | "semantic" | "graph" | "both";
export type WriteMode = "mock" | "dry-run" | "real";

export interface WorkshopConfig {
  mode: WriteMode;
  maxSteps: number;
  history: boolean;
  historyWindow: number;
  traces: boolean;
  extractUserStatements: boolean;
  mapToolResults: boolean;
  pinnedRules: boolean;
  onboarding: boolean;
  retrieval: RetrievalMode;
  approvalGate: boolean;
  recipientAllowlist: boolean;
  provenance: boolean;
  trustFilter: boolean;
}

export const config: WorkshopConfig = {
  // Write behaviour of tools (reads are always allowed).
  //   "mock"    = writes really change the seeded fake apps (deletes remove items)
  //   "dry-run" = writes are logged and reported as success, nothing changes
  //   "real"    = writes call real APIs (stubs in src/nsuite/real.ts, see README stage 7)
  mode: "mock",

  // Maximum number of model steps (LLM calls) per user turn.
  maxSteps: 8,

  // STAGE 1: short-term memory. true = Mastra message history is attached to the agent.
  history: false,

  // STAGE 1: how many stored messages are sent back to the model (Mastra `lastMessages`).
  // Tool calls count as messages. Small on purpose so a rule falls out of the window.
  historyWindow: 6,

  // STAGE 2: context traces. true = onStepFinish writes Step nodes and HAD_IN_CONTEXT edges to Neo4j.
  traces: false,

  // STAGE 3: persist user-stated facts and rules (one structured LLM call per user turn).
  extractUserStatements: false,

  // STAGE 3: map tool results (emails, events, issues) into graph entities, deterministically.
  mapToolResults: false,

  // STAGE 3: inject every Rule node from the graph into the context at every step.
  pinnedRules: false,

  // STAGE 3: onboarding. The agent asks who you are (name, where you live, preferred language, a fun fact) and pins what it knows about you.
  onboarding: false,

  // STAGE 4: retrieval before each answer. "none" | "semantic" | "graph" | "both"
  retrieval: "none",

  // STAGE 5: delete_email needs approval when a Rule says so. Enforced in code, not in the prompt.
  approvalGate: false,

  // STAGE 5: send_message is blocked for recipients outside the allowlist below.
  recipientAllowlist: false,

  // STAGE 6: store the source (and a trust level) on every fact written to memory.
  provenance: false,

  // STAGE 6: withhold low-trust facts when the question is about payments or accounts.
  trustFilter: false,
};

// STAGE 5: recipients send_message may contact when recipientAllowlist is on.
export const allowedRecipients: string[] = ["priya@northwind.test", "sam@northwind.test"];

// Internal sender domains. Anything else is "external" for provenance purposes (STAGE 6).
export const internalDomains: string[] = ["northwind.test"];
