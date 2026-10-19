// Keyword lookup over graph entities, used by the query_memory tool.
// (Graph *traversal* retrieval for stage 4 lives in graph/explore.ts.)
import { run } from "./driver.js";

const STOP = new Set("a an and are as at be but by do does for from how i in is it me my of on or our the their there this to was we what when where which who whom why will with you your should need prep prepare before about".split(" "));
export const keywords = (q: string) => [...new Set(q.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)))];

export async function lookupEntities(question: string) {
  const kw = keywords(question);
  if (!kw.length) return { events: [], issues: [], people: [] };
  const events = await run(
    `MATCH (e:Event) WHERE any(k IN $kw WHERE toLower(e.title + ' ' + coalesce(e.description,'') + ' ' + coalesce(e.day,'')) CONTAINS k)
     OPTIONAL MATCH (e)-[:ATTENDED_BY]->(p:Person) OPTIONAL MATCH (e)-[:ABOUT]->(i:Issue)
     RETURN e.id AS id, e.title AS title, e.day AS day, e.date AS date, e.time AS time, e.description AS description,
            collect(DISTINCT p.name) AS attendees, collect(DISTINCT i.id) AS tickets`,
    { kw },
  );
  const issues = await run(
    `MATCH (i:Issue) WHERE any(k IN $kw WHERE toLower(i.id + ' ' + coalesce(i.title,'') + ' ' + coalesce(i.description,'')) CONTAINS k)
     OPTIONAL MATCH (i)-[:OWNED_BY]->(o:Person) OPTIONAL MATCH (i)-[:BLOCKED_BY]->(b:Issue)
     RETURN i.id AS id, i.title AS title, i.status AS status, i.eta AS eta, o.name AS owner, collect(DISTINCT b.id) AS blocked_by`,
    { kw },
  );
  const people = await run(
    `MATCH (p:Person) WHERE toLower(p.name) IN $kw RETURN p.name AS name, p.role AS role`,
    { kw },
  );
  return { events, issues, people };
}
