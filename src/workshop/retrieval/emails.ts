// STAGE 4: semantic search over email bodies. Each Email node carries an `embedding` property, and the
// `email_embedding` vector index (graph/schema.cypher) answers "which emails mean something like this?".
// Embeddings come from a local model (@mastra/fastembed, bge-small-en-v1.5, 384 dimensions), so no API key is needed.
import { fastembed } from "@mastra/fastembed";
import { run } from "../graph/driver.js";

export const EMBEDDING_INDEX = "email_embedding";
export const TOP_K = 4;

const model = fastembed.small;
async function embed(values: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += 16) {
    const { embeddings } = await model.doEmbed({ values: values.slice(i, i + 16) });
    out.push(...embeddings);
  }
  return out;
}

interface EmailText { id: string; from?: string; to?: string[]; cc?: string[]; subject?: string; body?: string }

/** What gets embedded: the headers and the whole body, so a detail deep in the message is searchable. */
export const emailEmbeddingText = (e: EmailText) =>
  `Email from ${e.from ?? "unknown"}, to ${(e.to ?? []).join(", ")}${e.cc?.length ? `, cc ${e.cc.join(", ")}` : ""}: ${e.subject ?? ""}\n${e.body ?? ""}`;

/** Embed emails that have a body and no embedding yet, and store the vector on the node. */
export async function embedEmails(emails: EmailText[]): Promise<number> {
  const withBody = emails.filter((e) => e.body);
  if (!withBody.length) return 0;
  const done = await run<{ id: string }>("MATCH (e:Email) WHERE e.id IN $ids AND e.embedding IS NOT NULL RETURN e.id AS id", { ids: withBody.map((e) => e.id) });
  const have = new Set(done.map((r) => r.id));
  const todo = withBody.filter((e) => !have.has(e.id));
  if (!todo.length) return 0;
  const vectors = await embed(todo.map(emailEmbeddingText));
  await run(
    "UNWIND $rows AS r MATCH (e:Email {id: r.id}) CALL db.create.setNodeVectorProperty(e, 'embedding', r.vector)",
    { rows: todo.map((e, i) => ({ id: e.id, vector: vectors[i] })) },
  );
  return todo.length;
}

export interface EmailHit { id: string; subject: string; from: string; sender: string; date?: string; body: string; score: number }

/** The k emails whose meaning is closest to the question, found with the vector index. */
export async function searchEmails(question: string, k = TOP_K): Promise<EmailHit[]> {
  // bge models are trained to embed queries with this instruction prefix; leaving it out would handicap the search.
  const [vector] = await embed([`Represent this sentence for searching relevant passages: ${question}`]);
  return run<EmailHit>(
    `CALL db.index.vector.queryNodes($index, $k, $vector) YIELD node, score
     RETURN node.id AS id, node.subject AS subject, node.from AS \`from\`, node.sender AS sender, node.date AS date, node.body AS body, score
     ORDER BY score DESC`,
    { index: EMBEDDING_INDEX, k, vector },
  );
}
