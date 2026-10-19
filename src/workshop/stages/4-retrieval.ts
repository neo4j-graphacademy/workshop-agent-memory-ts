// STAGE 4: retrieval as tools. The agent decides when to search and when to walk the graph.
// Flag: retrieval = "none" | "semantic" | "graph" | "both".
//   semantic: search_emails (similarity over the embeddings stored on Email nodes)
//   graph:    explore_graph (walk from named nodes) and query_graph (exact questions: counts, absences, values)
//   both:     all three
// Nothing is added to the system prompt per question. What the model retrieves is a tool result, so it shows up
// in the trace as a ToolCall.
import { config } from "../../../workshop.config.js";
import { retrievalTools } from "../tools/index.js";
import type { Stage } from "./types.js";

const tools = {
  ...(config.retrieval === "semantic" || config.retrieval === "both" ? { search_emails: retrievalTools.search_emails } : {}),
  ...(config.retrieval === "graph" || config.retrieval === "both" ? { explore_graph: retrievalTools.explore_graph, query_graph: retrievalTools.query_graph } : {}),
};

const advice = [
  tools.search_emails && "search_emails finds emails by meaning, for when you do not know the exact words. It returns the closest few whether or not they answer the question.",
  tools.explore_graph && "explore_graph follows the saved relationships from a meeting, ticket, email, customer or project you name, to the owners, blockers and customers connected to it.",
  tools.query_graph && "query_graph answers exact questions: counts, lists, things with no meeting or no owner, and exact values.",
].filter(Boolean);

export const stage4: Stage = {
  tools,
  instructions: advice.length ? `\nTo answer questions about mail, meetings and tickets, choose the retrieval tool that fits the question. ${advice.join(" ")} Search first when the question describes something and names nothing you can look up; then explore from what it finds.` : "",
};
