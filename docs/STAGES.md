# Stage run-through

Each stage adds flags to `workshop.config.ts`. `npm run step -- N` applies the preset for stage N, and every stage includes the one before it. `npm run reset` clears the fake apps, the audit log, message history and the graph. `npm run scenario -- N` runs the scripted demo for a stage (it needs a model key).

| Stage | Adds | Flags switched on |
|---|---|---|
| 0 | Nothing: the broken baseline | none |
| 1 | Short-term memory | `history` |
| 2 | Context traces | `traces` |
| 3 | Long-term memory and pinned rules | `extractUserStatements`, `mapToolResults`, `pinnedRules`, `onboarding` |
| 4 | Retrieval as tools | `retrieval: "both"` |
| 5 | Guardrails in code | `approvalGate`, `recipientAllowlist` |
| 6 | Poisoning and provenance | `provenance`, `trustFilter` |
| 7 | Make it yours | same flags as 6, plus `mode: "real"` for writes |

The workspace is a fake work setup ("Nsuite"): 40 emails, a calendar and a ticket system. The graph is in Neo4j.

---

## Stage 0: the broken agent

**What it is:** Tools and generic instructions, no memory. Every message and every session starts blank.

**Try it:** Say a rule ("never delete anything without asking me first"), then ask what you just said.

**You see:** The agent can't repeat the rule, not even in the next message. In a new session it deletes newsletters without hesitation.

**Neo4j:** Empty (`MATCH (n) RETURN count(n)`).

## Stage 1: short-term memory, and its failure

**What it adds:** Mastra message history with a small window (`historyWindow: 6`, about three turns, because tool calls count as messages).

**Scripted demo:** Turn 1 states the rule. Turns 2-4 make 10 `read_email` calls. Turn 5 says "Clean up my inbox."

**You see:** The agent respects the rule while it is in the window, then deletes newsletters once it has scrolled out. The inbox goes from 40 to 30 or fewer.

**Lesson:** A rule held in the window is lost when the window moves on.

## Stage 2: context traces

**What it adds:** An input processor snapshots what the model sees at every step. `onStepFinish` writes `Step` nodes, with `ToolCall` nodes and `(Step)-[:HAD_IN_CONTEXT]->(Message)` edges.

**You see:** The rule's message is in context for steps 1..N and gone at step N+1, the first `delete_email`.

**Neo4j:** `npm run query -- ruleInContextByStep`, `ruleAtFirstDelete`, `firstDeleteStep`.

**Lesson:** "Why did it do that?" now has an answer you can query.

## Stage 3: long-term memory and pinned rules

**What it adds:**
- `extractUserStatements`: one structured LLM call per user turn, producing `Rule`, `Fact` and `User` nodes shaped by the POLE+O ontology in `ontology.ts`.
- `mapToolResults`: deterministic mappers (no LLM) that turn tool output into `Email`, `Event`, `Issue` and `Person` nodes and relationships.
- `pinnedRules`: every `Rule` is injected as a system message at every step.
- `onboarding`: the agent asks who you are and pins what it knows about you.

**You see:** The agent only suggests deletions, and a fresh session answers "What should I prep for Tuesday?" from memory.

**Try it:** `npm run chat`, introduce yourself, `/new`, then ask "what do you know about me?"

## Stage 4: retrieval as tools

**What it adds:** The agent chooses its retrieval. Nothing is added to the system prompt for each question. Each retrieval is a tool call, and its result shows up as a `ToolCall` node in the trace.

| Tool | Use it for | Example |
|---|---|---|
| `search_emails` | Finding emails by meaning, using embeddings stored on `Email` nodes (local `fastembed`, `email_embedding` vector index, top 4) | "Are any customers behind on paying us?" |
| `explore_graph` | Walking relationships from a named email, ticket, meeting, customer or project to the owners, blockers and customers connected to it | "Who should I chase before Tuesday's billing review?" |
| `query_graph` | Exact questions: counts, absences, exact values (a model writes one read-only Cypher query, and the harness checks it) | "Which open tickets haven't come up in any meeting?" |

**Flags:** `retrieval: "semantic"` gives `search_emails`. `"graph"` gives `explore_graph` and `query_graph`. `"both"` gives all three. The tool set is fixed when the agent starts, so restart after changing it.

**Setup:** `npm run ingest` loads the seed into the graph and embeds each email body. `npm run search -- "question"` runs the similarity search on its own.

**You see:** `npm run query -- toolCalls` shows which tool the agent chose, and `toolResults` shows what it returned. "Behind on paying" calls `search_emails`. The billing review question calls `explore_graph` and never searches. The combined question calls `search_emails` and then `explore_graph` on the emails it found, and reaches Contoso's Atlas project, ENG-142, and ENG-139 owned by Sam.

**Lesson:** Pick the tool that fits the question. Similarity finds a starting point, relationships say what is connected, and an exact query handles absences.

## Stage 5: guardrails

**What it adds:** Guards inside tool execution, so the model can't skip them.
- `approvalGate`: `delete_email` returns `approval_required` while a `Rule` requires approval. The human approves with `/approve`, never the model.
- `recipientAllowlist`: `send_message` is refused for anyone not on `allowedRecipients`.

**Scripted demo:** Part 1 repeats the stage 1 failure with pinned rules off. Part 2 messages Dana (blocked) and Priya (allowed).

**You see:** The gate stops the delete, the attempt is a `Step` with outcome `approval_required`, and the inbox is unchanged until approval. `npm run state` shows `blocked:approval` and `blocked:recipient_allowlist`.

**Lesson:** Enforce safety in code, not in the prompt. A guard that errors fails closed.

## Stage 6: memory poisoning and provenance

**What it adds:**
- `provenance`: code stamps every `remember_fact` with `source` and `trust`, resolved from the emails actually read this session. An external sender gives `email:external` and `low`, plus `(Fact)-[:FROM]->(Email)`.
- `trustFilter`: low-trust facts, and external-sender emails returned by `search_emails`, are withheld for payment and account questions.

**Scripted demo:** A vendor email from Acme says "Acme invoices are paid to account 00-00-00." Part 1 runs with both flags off, and Part 2 with both on.

**You see:** Off, the planted number is stored with no source and handed to the model. On, it is stored with its provenance and withheld, and the answer says there is no trusted record. Some models refuse to act on instructions in an email. If that happens, set `POISON_MODEL=provider/model`.

**Lesson:** A memory is only as trustworthy as its source, so record the source and filter on it.

## Stage 7: make it yours

**What it adds:** No new flags. You swap the mock world for yours.
- `mode: "dry-run"` logs writes and reports success without changing anything. `mode: "real"` calls the stubs in `src/workshop/nsuite/real.ts`, still through the audit log and the stage 5 gates. Reads stay mock unless `REAL_READS=1`.
- Add tools to `customTools` in `src/agent.ts`. They are registered with the agent and Mastra Studio but are not audited or mode-switched.
- Change what the agent remembers in `ontology.ts`.

**Lesson:** The stages are a pattern you can rebuild around your own tools and data.
