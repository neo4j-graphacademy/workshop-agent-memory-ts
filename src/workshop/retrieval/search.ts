// `npm run search -- "your question"`: the email similarity search on its own, with no agent and no graph walk.
// Prints the top four emails by cosine similarity, which is what the search_emails tool returns to the agent.
import { fileURLToPath } from "node:url";
import { closeDriver } from "../graph/driver.js";
import { searchEmails } from "./emails.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const question = process.argv.slice(2).join(" ").trim() || "Are any customers behind on paying us?";
  console.log(`Question: ${question}\n`);
  try {
    const hits = await searchEmails(question);
    if (!hits.length) console.log("No emails have an embedding yet. Run `npm run ingest` first.");
    else console.table(hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(2)), subject: h.subject, text: h.body.replace(/\s+/g, " ").slice(0, 60) + "..." })));
  } finally {
    await closeDriver();
  }
}
