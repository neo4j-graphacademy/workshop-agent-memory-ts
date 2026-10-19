// Small write/read helpers over the graph. Keeping Cypher here keeps hooks and processors readable.
import { run } from "./driver.js";
import { USER_ID } from "./pole.js";

export interface RuleRow { key: string; tool: string; mode: string; source: string; turn: number; text?: string }
export interface FactRow { text: string; source: string | null; trust: string | null; emailId?: string | null }

export const upsertSession = (id: string) =>
  run("MERGE (s:Session {id:$id}) ON CREATE SET s.started = timestamp()", { id });

export const upsertMessage = (m: { id: string; role: string; text: string; turn: number; sessionId: string }) =>
  run(
    `MERGE (s:Session {id:$sessionId})
     MERGE (m:Message {id:$id}) SET m.role=$role, m.text=$text, m.turn=$turn
     MERGE (s)-[:HAS_MESSAGE]->(m)`,
    m,
  );

export async function upsertRule(r: { tool: string; mode: string; source: string; turn: number; text?: string; messageId?: string }) {
  await run(
    `MERGE (r:Rule {key:$key}) SET r.tool=$tool, r.mode=$mode, r.source=$source, r.turn=$turn, r.text=$text
     MERGE (u:User {id:$userId})
     MERGE (u)-[:HAS_RULE]->(r)
     WITH r
     OPTIONAL MATCH (m:Message {id:$messageId})
     FOREACH (_ IN CASE WHEN m IS NULL THEN [] ELSE [1] END | MERGE (r)-[:STATED_IN]->(m))`,
    { ...r, userId: USER_ID, key: `${r.tool}:${r.mode}`, text: r.text ?? null, messageId: r.messageId ?? null },
  );
}

export const listRules = () =>
  run<RuleRow>("MATCH (r:Rule) RETURN r.key AS key, r.tool AS tool, r.mode AS mode, r.source AS source, r.turn AS turn, r.text AS text ORDER BY r.turn");

export async function upsertFact(f: { text: string; source: string | null; trust: string | null; emailId?: string | null; messageId?: string | null }) {
  await run(
    `MERGE (f:Fact {text:$text}) SET f.source=$source, f.trust=$trust
     WITH f
     OPTIONAL MATCH (e:Email {id:$emailId})
     FOREACH (_ IN CASE WHEN e IS NULL THEN [] ELSE [1] END | MERGE (f)-[:FROM]->(e))
     WITH f
     OPTIONAL MATCH (m:Message {id:$messageId})
     FOREACH (_ IN CASE WHEN m IS NULL THEN [] ELSE [1] END | MERGE (f)-[:STATED_IN]->(m))`,
    { ...f, emailId: f.emailId ?? null, messageId: f.messageId ?? null },
  );
}

export const listFacts = () =>
  run<FactRow>("MATCH (f:Fact) OPTIONAL MATCH (f)-[:FROM]->(e:Email) RETURN f.text AS text, f.source AS source, f.trust AS trust, e.id AS emailId ORDER BY f.text");

export interface ToolCallRow {
  id: string;                 // the model's toolCallId
  messageId?: string;         // assistant message the call is inside (known to the context recorder)
  tool: string;
  position?: number;
  props: Record<string, string | number | boolean>; // args (JSON), arg_<name>, state, outcome, result
  write: boolean;
  description: string;
}

/** Upsert ToolCall nodes: (Message)-[:MADE_CALL]->(ToolCall)-[:OF_TOOL]->(Tool). Both writers call this; MERGE makes it idempotent. */
export async function upsertToolCalls(sessionId: string, calls: ToolCallRow[]) {
  if (!calls.length) return;
  await run(
    `UNWIND $calls AS c
     MERGE (tc:ToolCall {id:c.id})
     SET tc += c.props, tc.tool = c.tool, tc.sessionId = $sessionId
     FOREACH (_ IN CASE WHEN c.position IS NULL THEN [] ELSE [1] END | SET tc.position = c.position)
     MERGE (t:Tool {name:c.tool}) SET t.write = c.write, t.description = c.description
     MERGE (tc)-[:OF_TOOL]->(t)
     WITH tc, c
     OPTIONAL MATCH (m:Message {id:c.messageId})
     FOREACH (_ IN CASE WHEN m IS NULL THEN [] ELSE [1] END | MERGE (m)-[:MADE_CALL]->(tc))`,
    { calls, sessionId },
  );
}

/** One Step per model step. A step may request 0..n tool calls, which form their own NEXT chain across the session. */
export async function writeStep(s: {
  sessionId: string; n: number; finishReason?: string; text?: string;
  messageIds: string[]; systemMessageIds: string[];
  calls: ToolCallRow[]; prevToolCallId: string | null;
}) {
  await run(
    `MERGE (sess:Session {id:$sessionId})
     MERGE (st:Step {id:$id}) SET st.n=$n, st.ts=timestamp(), st.sessionId=$sessionId, st.finishReason=$finishReason, st.text=$text
     MERGE (sess)-[:HAS_STEP]->(st)
     WITH st
     OPTIONAL MATCH (prev:Step {id:$prevId})
     FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | MERGE (prev)-[:NEXT]->(st))
     WITH st
     CALL (st) {
       UNWIND $messageIds AS mid
       MATCH (m:Message {id: mid})
       MERGE (st)-[:HAD_IN_CONTEXT]->(m)
       RETURN count(*) AS msgs
     }
     CALL (st) {
       UNWIND $systemMessageIds AS sid
       MATCH (s:SystemMessage {id: sid})
       MERGE (st)-[:HAD_IN_CONTEXT]->(s)
       RETURN count(*) AS sys
     }
     RETURN msgs, sys`,
    { ...s, id: `${s.sessionId}:${s.n}`, prevId: `${s.sessionId}:${s.n - 1}`, text: (s.text ?? "").slice(0, 300), finishReason: s.finishReason ?? null },
  );
  if (!s.calls.length) return;
  await upsertToolCalls(s.sessionId, s.calls);
  const ids = s.calls.map((c) => c.id);
  await run("MATCH (st:Step {id:$id}) UNWIND $ids AS cid MATCH (tc:ToolCall {id:cid}) MERGE (st)-[:REQUESTED]->(tc)", { id: `${s.sessionId}:${s.n}`, ids });
  // NEXT chain between consecutive tool calls (across steps and turns)
  const chain = ids.map((id, i) => ({ a: i === 0 ? s.prevToolCallId : ids[i - 1], b: id })).filter((p) => p.a);
  if (chain.length) await run("UNWIND $chain AS p MATCH (a:ToolCall {id:p.a}), (b:ToolCall {id:p.b}) MERGE (a)-[:NEXT]->(b)", { chain });
}

/** (:Message)-[:NEXT]->(:Message) in conversation order, and the tool calls each assistant message made. */
export async function writeConversation(rows: { id: string; role: string; text: string; turn: number }[], sessionId: string, calls: ToolCallRow[]) {
  await run(
    `MERGE (s:Session {id:$sessionId})
     WITH s UNWIND $rows AS r
     MERGE (m:Message {id:r.id}) SET m.role=r.role, m.text=r.text, m.turn=r.turn, m.sessionId=$sessionId
     MERGE (s)-[:HAS_MESSAGE]->(m)`,
    { sessionId, rows },
  );
  const pairs = rows.slice(1).map((r, i) => ({ a: rows[i].id, b: r.id }));
  if (pairs.length) await run("UNWIND $pairs AS p MATCH (a:Message {id:p.a}), (b:Message {id:p.b}) MERGE (a)-[:NEXT]->(b)", { pairs });
  await upsertToolCalls(sessionId, calls);
}

export interface SystemMessageRow {
  id: string; kind: string; text: string;
  rules?: string[];
}

/** Everything injected as a system message becomes a node, linked to what it was built from. */
export async function writeSystemMessages(rows: SystemMessageRow[], userMessageId: string | null) {
  if (!rows.length) return;
  await run("UNWIND $rows AS r MERGE (s:SystemMessage {id:r.id}) SET s.kind=r.kind, s.text=r.text", { rows });
  const pins = rows.flatMap((r) => (r.rules ?? []).map((key) => ({ id: r.id, key })));
  if (pins.length) await run("UNWIND $pins AS p MATCH (s:SystemMessage {id:p.id}), (r:Rule {key:p.key}) MERGE (s)-[:PINS]->(r)", { pins });
  if (userMessageId) {
    await run(
      "UNWIND $ids AS id MATCH (s:SystemMessage {id:id}), (m:Message {id:$mid}) WHERE s.kind <> 'instructions' MERGE (s)-[:ADDED_FOR]->(m)",
      { ids: rows.map((r) => r.id), mid: userMessageId },
    );
  }
}
