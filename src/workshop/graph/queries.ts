// Named queries used by the README and the scenarios. `npm run query -- <name> [param=value ...]`
import { fileURLToPath } from "node:url";
import { closeDriver, run } from "./driver.js";

export const queries = {
  /** Which Message holds the user's rule? Matches the user's first message containing $contains. */
  ruleMessage: {
    description: "The user message that states the rule (first user message containing $contains)",
    cypher: `MATCH (m:Message {role:'user'}) WHERE toLower(m.text) CONTAINS toLower($contains)
             RETURN m.id AS messageId, m.turn AS turn, m.text AS text ORDER BY m.turn LIMIT 1`,
    defaults: { contains: "never delete" },
  },
  /** Last step in which the rule's Message was in context. */
  lastStepWithMessage: {
    description: "Last step in which the rule Message was in context",
    cypher: `MATCH (m:Message {role:'user'}) WHERE toLower(m.text) CONTAINS toLower($contains)
             WITH m ORDER BY m.turn LIMIT 1
             MATCH (m)<-[:HAD_IN_CONTEXT]-(s:Step)
             RETURN m.id AS messageId, s.sessionId AS sessionId, max(s.n) AS lastStepInContext`,
    defaults: { contains: "never delete" },
  },
  /** For each step: was the rule's Message in context? */
  ruleInContextByStep: {
    description: "Per step: was the rule message in context? (look for where it flips to false)",
    cypher: `MATCH (m:Message {role:'user'}) WHERE toLower(m.text) CONTAINS toLower($contains)
             WITH m ORDER BY m.turn LIMIT 1
             MATCH (st:Step) WHERE st.sessionId = coalesce($sessionId, st.sessionId)
             OPTIONAL MATCH (st)-[c:HAD_IN_CONTEXT]->(m)
             RETURN st.n AS step, [(st)-[:REQUESTED]->(tc) | tc.tool] AS tools, c IS NOT NULL AS ruleInContext
             ORDER BY st.sessionId, st.n`,
    defaults: { contains: "never delete", sessionId: null },
  },
  /** The first delete_email Step of a session. */
  firstDeleteStep: {
    description: "First Step that requested a delete_email ToolCall",
    cypher: `MATCH (st:Step)-[:REQUESTED]->(tc:ToolCall {tool:'delete_email'}) WHERE st.sessionId = coalesce($sessionId, st.sessionId)
             RETURN st.sessionId AS sessionId, st.n AS step, tc.args AS args, tc.outcome AS outcome ORDER BY st.sessionId, st.n, tc.position LIMIT 1`,
    defaults: { sessionId: null },
  },
  /** Was the rule in context at the first delete step? */
  ruleAtFirstDelete: {
    description: "Last step with the rule in context vs the first step that requested delete_email",
    cypher: `MATCH (m:Message {role:'user'}) WHERE toLower(m.text) CONTAINS toLower($contains)
             WITH m ORDER BY m.turn LIMIT 1
             MATCH (del:Step)-[:REQUESTED]->(:ToolCall {tool:'delete_email'}) WHERE del.sessionId = coalesce($sessionId, del.sessionId)
             WITH m, del ORDER BY del.sessionId, del.n LIMIT 1
             MATCH (s:Step {sessionId: del.sessionId}) WHERE s.n <= del.n
             OPTIONAL MATCH (s)-[c:HAD_IN_CONTEXT]->(m)
             WITH del, max(CASE WHEN c IS NOT NULL THEN s.n ELSE -1 END) AS lastStepWithRule
             RETURN lastStepWithRule, del.n AS firstDeleteStep, lastStepWithRule < del.n AS ruleHadLeftContext`,
    defaults: { contains: "never delete", sessionId: null },
  },
  /** Path from an Event to the person who owns the blocker of the Issue it is about. */
  eventToBlockerOwner: {
    description: "Event -> Issue -> blocking Issue -> owner (the relationship flat recall misses)",
    cypher: `MATCH (e:Event)-[:ABOUT]->(i:Issue)-[:BLOCKED_BY]->(b:Issue)-[:OWNED_BY]->(o:Person)
             WHERE toLower(e.title) CONTAINS toLower($event)
             RETURN e.title AS event, e.day AS day, i.id AS issue, b.id AS blocker, b.title AS blockerTitle, b.eta AS blockerEta, o.name AS owner`,
    defaults: { event: "billing review" },
  },
  /** A question about absence. Similarity cannot return "nothing matched". */
  unscheduledTickets: {
    description: "Open tickets that no meeting is about (an absence: there is no text for similarity to find)",
    cypher: `MATCH (i:Issue) WHERE coalesce(i.status, '') <> 'done' AND NOT EXISTS { (:Event)-[:ABOUT]->(i) }
             OPTIONAL MATCH (i)-[:OWNED_BY]->(o:Person)
             RETURN i.id AS issue, i.title AS title, i.status AS status, o.name AS owner ORDER BY issue`,
    defaults: {},
  },
  /** From emails that similarity found to the work behind the customers they mention. */
  overdueToWork: {
    description: "Emails -> the customer they mention -> its projects, tickets, blockers and contacts",
    cypher: `MATCH (m:Email)-[:MENTIONS]->(c:Customer) WHERE m.id IN split($emails, ',')
             OPTIONAL MATCH (c)<-[:FOR]-(p:Project)
             OPTIONAL MATCH (p)<-[:PART_OF]-(i:Issue)
             OPTIONAL MATCH (i)-[:BLOCKED_BY]->(b:Issue)-[:OWNED_BY]->(bo:Person)
             OPTIONAL MATCH (c)<-[:WORKS_FOR]-(contact:Person)
             RETURN m.id AS email, c.name AS customer, collect(DISTINCT contact.name) AS contacts, p.name AS project,
                    i.id AS issue, i.status AS status, b.id AS blocker, bo.name AS blockerOwner
             ORDER BY customer`,
    defaults: { emails: "e-038,e-039,e-040" },
  },
  /** Facts that came from an external email. */
  externalFacts: {
    description: "Facts whose source is an external email",
    cypher: `MATCH (f:Fact) WHERE f.source = 'email:external' OPTIONAL MATCH (f)-[:FROM]->(e:Email)
             RETURN f.text AS fact, f.source AS source, f.trust AS trust, e.id AS email, e.sender AS sender`,
    defaults: {},
  },
  allFacts: {
    description: "Every Fact with its provenance (if any)",
    cypher: `MATCH (f:Fact) OPTIONAL MATCH (f)-[:FROM]->(e:Email) RETURN f.text AS fact, f.source AS source, f.trust AS trust, e.id AS email`,
    defaults: {},
  },
  /** The User node and everything it links to (POLE+O entities). */
  userProfile: {
    description: "The User, their preferences and the places, people and organizations they mentioned",
    cypher: `MATCH (u:User) OPTIONAL MATCH (u)-[r]->(n)
             RETURN u.name AS name, u.preferences AS preferences, u.funFact AS funFact, type(r) AS rel, head(labels(n)) AS type, coalesce(n.name, n.title) AS entity`,
    defaults: {},
  },
  allRules: {
    description: "Every Rule",
    cypher: `MATCH (r:Rule) RETURN r.tool AS tool, r.mode AS mode, r.source AS source, r.turn AS turn`,
    defaults: {},
  },
  conversation: {
    description: "The conversation as a NEXT chain with the tool calls each assistant message made",
    cypher: `MATCH (m:Message) WHERE m.sessionId = coalesce($sessionId, m.sessionId)
             OPTIONAL MATCH (m)-[:MADE_CALL]->(tc:ToolCall)
             OPTIONAL MATCH (m)-[:NEXT]->(next:Message)
             RETURN m.sessionId AS sessionId, m.turn AS turn, m.role AS role, left(m.text, 50) AS text,
                    collect(tc.tool + ' ' + tc.args) AS toolCalls, next.role AS nextRole
             ORDER BY m.sessionId, m.turn, m.role DESC`,
    defaults: { sessionId: null },
  },
  toolCalls: {
    description: "The ToolCall chain: (Message)-[MADE_CALL]->(ToolCall)-[NEXT]->(ToolCall), with arguments and outcome",
    cypher: `MATCH (m:Message)-[:MADE_CALL]->(tc:ToolCall) WHERE tc.sessionId = coalesce($sessionId, tc.sessionId)
             OPTIONAL MATCH (tc)-[:NEXT]->(next:ToolCall)
             RETURN tc.sessionId AS sessionId, m.turn AS turn, tc.tool AS tool, tc.args AS args, tc.outcome AS outcome, next.tool AS nextTool
             ORDER BY tc.sessionId, m.turn, tc.position`,
    defaults: { sessionId: null },
  },
  systemContext: {
    description: "What each injected system message (instructions, pinned rules, what is known about the user) was built from",
    cypher: `MATCH (s:SystemMessage) WHERE s.kind <> 'instructions'
             OPTIONAL MATCH (s)-[:PINS]->(r:Rule)
             RETURN s.kind AS kind, collect(r.key) AS pinnedRules, left(s.text, 80) AS text
             ORDER BY kind`,
    defaults: {},
  },
  toolResults: {
    description: "What a tool returned (explore_graph unless tool=<name> is given), with the arguments it was called with. Results are clipped to 1000 characters",
    cypher: `MATCH (tc:ToolCall {tool: $tool}) WHERE tc.sessionId = coalesce($sessionId, tc.sessionId)
             RETURN tc.sessionId AS sessionId, tc.args AS args, tc.result AS result
             ORDER BY tc.sessionId, tc.id`,
    defaults: { tool: "explore_graph", sessionId: null },
  },
  stepContext: {
    description: "For each step: the tools it requested, how many messages and which system messages were in context",
    cypher: `MATCH (st:Step) WHERE st.sessionId = coalesce($sessionId, st.sessionId)
             RETURN st.sessionId AS sessionId, st.n AS step, [(st)-[:REQUESTED]->(tc) | tc.tool] AS tools,
                    size([(st)-[:HAD_IN_CONTEXT]->(m:Message) | m]) AS messages,
                    [(st)-[:HAD_IN_CONTEXT]->(s:SystemMessage) | s.kind] AS system
             ORDER BY st.sessionId, st.n`,
    defaults: { sessionId: null },
  },
  steps: {
    description: "Model steps of a session (or all) with the tool calls each requested and their outcomes",
    cypher: `MATCH (st:Step) WHERE st.sessionId = coalesce($sessionId, st.sessionId)
             OPTIONAL MATCH (st)-[:REQUESTED]->(tc:ToolCall)
             RETURN st.sessionId AS sessionId, st.n AS n, tc.tool AS tool, tc.args AS args, tc.outcome AS outcome
             ORDER BY st.sessionId, st.n, tc.position`,
    defaults: { sessionId: null },
  },
} as const;

export type QueryName = keyof typeof queries;

export async function runQuery(name: QueryName, params: Record<string, unknown> = {}) {
  const q = queries[name] as { cypher: string; defaults?: Record<string, unknown> };
  return run(q.cypher, { ...(q.defaults ?? {}), ...params });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, ...kv] = process.argv.slice(2);
  if (!name || !(name in queries)) {
    console.log("Usage: npm run query -- <name> [param=value ...]\n");
    for (const [n, q] of Object.entries(queries)) console.log(`  ${n.padEnd(22)} ${q.description}`);
    process.exit(name ? 1 : 0);
  }
  const params = Object.fromEntries(kv.map((p) => p.split("=") as [string, string]));
  console.table(await runQuery(name as QueryName, params));
  await closeDriver();
}
