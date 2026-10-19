// Per-process "current session" context shared by processors, hooks and tools.
// Tools and processors do not otherwise know which thread/turn/step they are in.
export interface SystemMeta {
  rules?: string[]; // Rule keys the block pins
}

export interface RuntimeState {
  sessionId: string;
  turn: number;         // user turns so far in this session
  step: number;         // model steps so far in this session (global, not per turn)
  lastToolCallId: string | null; // end of the session's ToolCall NEXT chain
  userText: string;     // latest user message text
  userMessageId: string | null;
  toolMode: "none" | string[] | null; // set by the /tools chat command
  injectedRuleKeys: string[]; // Rule nodes injected into context this step
  /** What each injected system block was built from, keyed by system-message tag. Written to the graph by ContextRecorder. */
  systemMeta: Record<string, SystemMeta>;
  turnOf: Map<string, number>; // message id -> user turn it belongs to
  emailsRead: Map<string, { id: string; sender: string; subject: string; body: string }>;
  /** Context snapshots taken before each model step, consumed in order by onStepFinish. */
  pendingContexts: { messageIds: string[]; systemMessageIds: string[] }[];
  injected: string[];   // labelled context blocks injected this turn (for demos)
  factsServed: string[];   // memory facts/chunks actually handed to the model (harness-side evidence)
  factsWithheld: string[]; // ... and the ones the trust filter held back
}

export const runtime: RuntimeState = {
  sessionId: "session-0",
  turn: 0,
  step: 0,
  lastToolCallId: null,
  userText: "",
  userMessageId: null,
  toolMode: null,
  injectedRuleKeys: [],
  systemMeta: {},
  turnOf: new Map(),
  emailsRead: new Map(),
  pendingContexts: [],
  injected: [],
  factsServed: [],
  factsWithheld: [],
};

export function newSession(id: string): void {
  runtime.sessionId = id;
  runtime.turn = 0;
  runtime.step = 0;
  runtime.lastToolCallId = null;
  runtime.userText = "";
  runtime.userMessageId = null;
  runtime.toolMode = null;
  runtime.injectedRuleKeys = [];
  runtime.systemMeta = {};
  runtime.turnOf = new Map();
  runtime.emailsRead = new Map();
  runtime.pendingContexts = [];
  runtime.injected = [];
  runtime.factsServed = [];
  runtime.factsWithheld = [];
}
