// STAGE 4+: explore_graph (walk from named nodes) and query_graph (a text-to-Cypher tool).
//
// explore_graph links the nodes a question names and walks the relationships around them. It cannot count or find
// absences, which is what query_graph is for: a model writes one read-only Cypher query against the graph the agent
// has built up, the harness checks it, and the rows come back. Similarity cannot answer those questions either.
//
// This is a convenience for the data graph, not a security boundary. Facts and rules are not in its schema and its
// queries cannot name them, but standing rules and trust are enforced elsewhere (query_memory, the guards).
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { EXTRACTION_MODEL, modelConfig } from "../env.js";
import { runRead } from "../graph/driver.js";
import { exploreGraph } from "../graph/explore.js";
import { DENIED_LABELS, getGraphSchema } from "../graph/schema.js";
import { spec } from "./spec.js";

export { DENIED_LABELS };
export const MAX_ROWS = 25;

const stripStrings = (c: string) => c.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");

/** Reject anything that is not one read-only query over the data graph. Returns an error message, or null when fine. */
export function checkCypher(cypher: string): string | null {
  const text = stripStrings(cypher).replace(/\/\/.*$/gm, "").trim().replace(/;\s*$/, "");
  if (!text) return "No query was written";
  if (text.includes(";")) return "Only one statement is allowed";
  if (!/^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i.test(text)) return "A query must start with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN";
  const write = text.match(/\b(create|merge|delete|detach|set|remove|drop|foreach|call|load|apoc|dbms)\b/i);
  if (write) return `"${write[1].toUpperCase()}" is not allowed: the tool is read-only`;
  const denied = text.match(new RegExp(`:\\s*\`?(${DENIED_LABELS.join("|")})\\b`, "i"));
  if (denied) return `The ${denied[1]} label is not part of the data graph`;
  return null;
}

// The schema is read from the database on every question (cached until something is written), so the writer always
// sees the labels in the graph right now, not a list someone wrote by hand.
const instructions = (schema: string) => `You write one read-only Neo4j Cypher query that answers a question, using only this schema.

${schema}

Rules: use MATCH, OPTIONAL MATCH, WITH, WHERE, RETURN, ORDER BY and aggregation only. Never write data. Return readable columns (ids, names, titles), not whole nodes. To find something that does NOT exist, use NOT EXISTS { pattern }. Match text case-insensitively with toLower(). Add LIMIT ${MAX_ROWS} unless you are aggregating.`;

export async function writeCypher(question: string): Promise<string> {
  const writer = new Agent({ id: "cypher-writer", name: "cypher-writer", model: modelConfig(EXTRACTION_MODEL), instructions: instructions(await getGraphSchema()) });
  const res = await writer.generate(question, { structuredOutput: { schema: z.object({ cypher: z.string().describe("A single read-only Cypher query") }) } });
  return String((res.object as { cypher?: string } | undefined)?.cypher ?? "").trim();
}

export const query_graph = spec({
  id: "query_graph",
  description:
    "Answer an exact question about the emails, events, tickets, people, customers and projects the agent has saved: counts, lists, absences (things with no meeting or no owner) and relationships. Describe the question in words; a read-only Cypher query is written and run for you. Prefer this over similarity for 'how many', 'which have no', and 'who owns'.",
  schema: z.object({ question: z.string() }),
  write: false,
  mock: async ({ question }) => {
    const cypher = await writeCypher(question);
    const problem = checkCypher(cypher);
    if (problem) return { cypher, error: problem };
    try {
      const rows = await runRead(cypher, {}, DENIED_LABELS);
      return { cypher, rowCount: rows.length, rows: rows.slice(0, MAX_ROWS) };
    } catch (err) {
      return { cypher, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const explore_graph = spec({
  id: "explore_graph",
  description:
    "Walk the saved graph outward from nodes you name and return what is connected to them, as JSON. Give the starts as strings: an email id ('e-040'), a ticket id ('ENG-142'), a meeting title or day ('Billing review'), or a customer or project name. You get back the emails, meetings, tickets, owners, blockers, customers and projects around them, including who owns what blocks a ticket and when it is due. Use it after search_emails to follow an email to the work behind it, or on its own when the question already names the meeting, ticket, customer or project.",
  schema: z.object({ starts: z.array(z.string()).min(1).describe("Ids, titles or names to start the walk from") }),
  write: false,
  mock: async ({ starts }) =>
    (await exploreGraph(starts)) ?? { notice: `Nothing in the graph matches ${starts.map((s) => `"${s}"`).join(", ")}. The graph only holds what has been read or ingested, so try an id or a name exactly as it appears.` },
});
