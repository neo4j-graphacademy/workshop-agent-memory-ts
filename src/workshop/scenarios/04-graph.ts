import { ingestSeed } from "../harness/ingest.js";
import { searchEmails } from "../retrieval/emails.js";
import type { Ctx, Scenario } from "./ctx.js";

// Four kinds of question, and which retrieval tool each one needs. The agent chooses the tool, so the scenario prints
// which tools it called (from the trace) next to what it answered.
const FUZZY = "Are any customers behind on paying us?";
const NAMED = "Who should I chase before Tuesday's billing review?";
const BOTH = "Are any customers behind on paying us, and is anything on our side holding it up?";
const EXACT = "Which open tickets haven't come up in any meeting?";

const RETRIEVAL = ["search_emails", "explore_graph", "query_graph"];
const toolsCalled = async (ctx: Ctx, sessionId: string) =>
  (await ctx.query("steps", { sessionId })).map((r) => String(r.tool ?? "")).filter((t) => RETRIEVAL.includes(t));

const namesSam = (a: string) => /\bSam\b/.test(a);
const mentionsThursday = (a: string) => /thursday|06-12|June 12/i.test(a);
const namesCustomers = (a: string) => ["Contoso", "Fabrikam", "Tailspin"].every((c) => a.includes(c));
const namesUnscheduled = (a: string) => ["ENG-139", "ENG-150", "ENG-151"].every((t) => a.includes(t));

export const scenario: Scenario = {
  stage: 4,
  slug: "04-graph",
  title: "Stage 4: retrieval tools. Search email bodies, walk the graph, and query it exactly",
  async run(ctx) {
    ctx.title("Setup: load the emails, meetings and tickets into the graph and embed each email body (deterministic mappers, no LLM)");
    ctx.verified("tool outputs ingested into the graph", await ingestSeed());

    ctx.title(`What a similarity search over the email bodies returns for: "${FUZZY}"`);
    for (const h of await searchEmails(FUZZY)) ctx.note(`${h.id} (${h.score.toFixed(2)}) ${h.subject}`);
    ctx.note("The emails say 'past due', 'overdue' and 'transfer delayed', never 'behind on paying'. The words differ and the meaning matches.");

    const ask = async (label: string, question: string, expected: string, check: (a: string) => string[]) => {
      ctx.title(`${label}: "${question}"`);
      const sessionId = ctx.newSession(`S4-${label}`);
      const answer = await ctx.say(question);
      ctx.verified(`retrieval tools the agent called (expected ${expected})`, (await toolsCalled(ctx, sessionId)).join(" -> ") || "none");
      for (const line of check(answer)) ctx.verified(...(line.split(": ") as [string, string]));
    };

    await ask("Fuzzy", FUZZY, "search_emails", (a) => [`names the overdue customers: ${namesCustomers(a)}`]);
    await ask("Named", NAMED, "explore_graph, no search", (a) => [`names Sam: ${namesSam(a)}`, `notes the ETA is Thursday: ${mentionsThursday(a)}`]);
    await ask("Both", BOTH, "search_emails -> explore_graph", (a) => [
      `names the overdue customers: ${namesCustomers(a)}`, `names Sam: ${namesSam(a)}`, `notes the ETA is Thursday: ${mentionsThursday(a)}`,
    ]);
    await ask("Exact", EXACT, "query_graph", (a) => [`names ENG-139, ENG-150 and ENG-151: ${namesUnscheduled(a)}`]);

    ctx.title("Summary");
    ctx.note("Fuzzy: the question describes a topic and names nothing to look up, so the agent searches the email bodies by meaning.");
    ctx.note("Named: the question names the meeting, so the agent looks it up in the graph and follows ABOUT, BLOCKED_BY and OWNED_BY. Similarity is not involved.");
    ctx.note("Both: similarity finds the payment emails, and the graph walk from them reaches the tickets and the person who owns the blocker.");
    ctx.note("Exact: a list of what is missing is a query, not a search.");
  },
};
