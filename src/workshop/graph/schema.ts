// The graph schema the Cypher-writing tool sees, read from the live database with APOC instead of written by hand.
// It shows what the agent has actually saved, including labels and relationships from your ontology.ts.
// Falls back to the ontology when APOC is missing or the graph is still empty.
import { ontology } from "./ontology.js";
import { run } from "./driver.js";

/** Labels a model-written query may not name: the agent's own memory and trace. Kept here so the schema never shows them. */
export const DENIED_LABELS = ["Fact", "Rule", "Message", "SystemMessage", "Step", "ToolCall", "Session", "Tool", "User"];

interface MetaNode { type: "node"; labels?: string[]; properties?: Record<string, { type: string }>; relationships?: Record<string, { direction: "in" | "out"; labels: string[] }> }
interface MetaRel { type: "relationship" }
type Meta = Record<string, MetaNode | MetaRel>;

/** Pure rendering of `apoc.meta.schema()` output. Exported for tests. */
export function renderApocSchema(meta: Meta, denied: string[] = DENIED_LABELS): string {
  const nodes = Object.entries(meta).filter((e): e is [string, MetaNode] => e[1].type === "node" && !denied.includes(e[0]));
  if (!nodes.length) return "";
  const lines = ["Nodes"];
  for (const [label, n] of nodes) {
    const props = Object.keys(n.properties ?? {}).filter((k) => k !== "embedding").join(", "); // a 384-number vector is no use in a query's schema
    lines.push(`(:${label}${props ? ` {${props}}` : ""})`);
  }
  lines.push("Relationships");
  const seen = new Set<string>();
  for (const [label, n] of nodes) {
    for (const [type, r] of Object.entries(n.relationships ?? {})) {
      if (r.direction !== "out") continue;
      const targets = r.labels.filter((l) => !denied.includes(l));
      if (!targets.length) continue;
      const line = `(:${label})-[:${type}]->(${targets.map((t) => `:${t}`).join(" or ")})`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  lines.push('A node can carry two labels, a type and a subtype, like (:Person:Employee). The graph only holds what the agent has already read or been told, so an empty result can mean "not seen yet".');
  return lines.join("\n");
}

/** What the ontology says could exist, for before anything has been saved. */
export function renderOntologySchema(o = ontology): string {
  const nodes = Object.entries(o.entities).flatMap(([t, d]) => [`(:${t})`, ...Object.keys(d.subtypes).map((s) => `(:${t}:${s})`)]);
  const rels = Object.entries(o.relations).map(([r, d]) => `(${d.from.map((t) => `:${t}`).join(" or ") || "any"})-[:${r}]->(${d.to.map((t) => `:${t}`).join(" or ") || "any"})`);
  return `Nodes\n${nodes.join("\n")}\nRelationships\n${rels.join("\n")}\nThe graph only holds what the agent has already read or been told, so an empty result can mean "not seen yet".`;
}

let cached: string | undefined;
/** Call after anything is written to the graph, so the next question sees the new labels. */
export const invalidateGraphSchema = () => { cached = undefined; };

export async function getGraphSchema(): Promise<string> {
  if (cached !== undefined) return cached;
  let text = "";
  try {
    const rows = await run<{ value: Meta }>("CALL apoc.meta.schema() YIELD value RETURN value");
    text = renderApocSchema(rows[0]?.value ?? {});
  } catch {
    // APOC is not installed (preflight says so). Use the ontology instead.
  }
  return (cached = text || renderOntologySchema());
}
