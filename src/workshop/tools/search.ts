// STAGE 4+: search_emails, semantic search over the email bodies stored in the graph.
import { z } from "zod";
import { config } from "../../../workshop.config.js";
import { isExternalSender } from "../graph/provenance.js";
import { isSensitiveQuestion } from "../processors/trustFilter.js";
import { searchEmails, TOP_K } from "../retrieval/emails.js";
import { runtime } from "../runtime.js";
import { spec } from "./spec.js";

const SNIPPET_CHARS = 600;

export const search_emails = spec({
  id: "search_emails",
  description:
    "Search the body text of the emails saved in the graph by meaning, not by exact words, and return the closest few with a similarity score. Use it to find what an email said when you do not know its subject or sender, for example 'who is waiting on internal approval before paying'. It always returns the closest emails even when none is relevant, so check the text, and it cannot count or list what is missing. Use read_email for a whole message.",
  schema: z.object({ query: z.string().describe("What you are looking for, described in your own words"), limit: z.number().int().min(1).max(10).optional().describe(`How many emails to return, default ${TOP_K}`) }),
  write: false,
  mock: async ({ query, limit }) => {
    const hits = await searchEmails(query, limit ?? TOP_K);
    // STAGE 6: text from external senders is untrusted, so it is withheld for payment and account questions.
    const guard = config.trustFilter && isSensitiveQuestion(`${query} ${runtime.userText}`);
    const withheld = guard ? hits.filter((h) => !!h.sender && isExternalSender(h.sender)) : [];
    const kept = hits.filter((h) => !withheld.includes(h));
    const text = (h: (typeof hits)[number]) => `Email ${h.id} from ${h.from}: ${h.subject}\n${h.body}`;
    runtime.factsServed.push(...kept.map(text));
    runtime.factsWithheld.push(...withheld.map(text));
    return {
      results: kept.map((h) => ({ id: h.id, subject: h.subject, from: h.from, date: h.date, score: Number(h.score.toFixed(2)), text: h.body.replace(/\s+/g, " ").slice(0, SNIPPET_CHARS) })),
      ...(withheld.length ? { notice: `${withheld.length} email(s) from external senders were withheld: this question is about payments or accounts. Verify through a trusted channel.` } : {}),
      ...(!hits.length ? { notice: "No emails have been embedded yet, so there is nothing to search." } : {}),
    };
  },
});
