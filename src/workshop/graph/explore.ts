// STAGE 4: walk the graph from the nodes a question names. LINK finds the starting nodes by id, title or name,
// then WALK follows the relationships around them (Email -> Customer -> Project -> Issue -> blocker -> owner,
// Event -> Issue). The result is plain data for the model to read, not a sentence: shaping it is this file's job,
// and what the model does with it is up to the model.
import { run } from "./driver.js";
import { withWeekday } from "../nsuite/state.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// The model miscounts weekdays from a bare date, so the weekday is attached in code.
const when = (eta: unknown) => (typeof eta === "string" && ISO_DATE.test(eta) ? withWeekday(eta) : eta);

// 1) LINK: every start the model gave is matched by plain string comparison against ids, titles and names.
const LINK = `
UNWIND $starts AS s
CALL (s) {
  MATCH (e:Event)
  WHERE toLower(s) CONTAINS toLower(e.title) OR (e.day IS NOT NULL AND toLower(s) CONTAINS toLower(e.day))
  RETURN 'Event' AS label, e.id AS key
  UNION
  MATCH (i:Issue) WHERE toLower(s) CONTAINS toLower(i.id)
  RETURN 'Issue' AS label, i.id AS key
  UNION
  MATCH (m:Email) WHERE toLower(s) CONTAINS toLower(m.id)
  RETURN 'Email' AS label, m.id AS key
  UNION
  MATCH (c:Customer) WHERE toLower(s) CONTAINS toLower(c.name)
  RETURN 'Customer' AS label, c.name AS key
  UNION
  MATCH (p:Project) WHERE toLower(s) CONTAINS toLower(p.name)
  RETURN 'Project' AS label, p.name AS key
}
RETURN label, collect(DISTINCT key) AS keys`;

// 2) WALK, once per kind of thing. These do not depend on each other, so they run together.
const ISSUES = `
CALL () {
  MATCH (i:Issue) WHERE i.id IN $issues RETURN i
  UNION
  MATCH (e:Event)-[:ABOUT]->(i:Issue) WHERE e.id IN $events RETURN i
  UNION
  MATCH (p:Project)<-[:PART_OF]-(i:Issue) WHERE p.name IN $projects RETURN i
  UNION
  MATCH (c:Customer)<-[:FOR]-(:Project)<-[:PART_OF]-(i:Issue) WHERE c.name IN $customers RETURN i
  UNION
  MATCH (m:Email)-[:MENTIONS]->(:Project)<-[:PART_OF]-(i:Issue) WHERE m.id IN $emails RETURN i
  UNION
  MATCH (m:Email)-[:MENTIONS]->(:Customer)<-[:FOR]-(:Project)<-[:PART_OF]-(i:Issue) WHERE m.id IN $emails RETURN i
  UNION
  MATCH (m:Email)-[:SENT_BY]->(:Person)-[:WORKS_FOR]->(:Customer)<-[:FOR]-(:Project)<-[:PART_OF]-(i:Issue) WHERE m.id IN $emails RETURN i
}
WITH DISTINCT i
OPTIONAL MATCH (i)-[:OWNED_BY]->(io:Person)
OPTIONAL MATCH (i)-[:BLOCKED_BY]->(blocker:Issue)
OPTIONAL MATCH (blocker)-[:OWNED_BY]->(bo:Person)
OPTIONAL MATCH (i)-[:PART_OF]->(p:Project)-[:FOR]->(c:Customer)
RETURN i{.id, .title, .status, .eta} AS issue, io.name AS owner, blocker{.id, .title, .status, .eta} AS blocker, bo.name AS blockerOwner, p.name AS project, c.name AS customer,
       [(ev:Event)-[:ABOUT]->(i) | ev{.title, .day, .time, attendees: [(ev)-[:ATTENDED_BY]->(a:Person) | a.name]}] AS meetings`;

const CUSTOMERS = `
CALL () {
  MATCH (c:Customer) WHERE c.name IN $customers RETURN c
  UNION
  MATCH (p:Project)-[:FOR]->(c:Customer) WHERE p.name IN $projects RETURN c
  UNION
  MATCH (m:Email)-[:MENTIONS]->(c:Customer) WHERE m.id IN $emails RETURN c
  UNION
  MATCH (m:Email)-[:MENTIONS]->(:Project)-[:FOR]->(c:Customer) WHERE m.id IN $emails RETURN c
  UNION
  MATCH (m:Email)-[:SENT_BY]->(:Person)-[:WORKS_FOR]->(c:Customer) WHERE m.id IN $emails RETURN c
}
WITH DISTINCT c
RETURN c.name AS customer, [(c)<-[:WORKS_FOR]-(p:Person) | p.name] AS contacts, [(c)<-[:FOR]-(pr:Project) | pr.name] AS projects`;

const EMAILS = `
MATCH (m:Email) WHERE m.id IN $emails
OPTIONAL MATCH (m)-[:MENTIONS]->(x) WHERE x:Customer OR x:Project
OPTIONAL MATCH (m)-[:SENT_BY]->(s:Person)
RETURN m.id AS id, m.subject AS subject, m.sender AS sender, s.name AS person, collect(x.name) AS mentions`;

const EVENTS = `
MATCH (e:Event) WHERE e.id IN $events
OPTIONAL MATCH (e)-[:ATTENDED_BY]->(p:Person)
OPTIONAL MATCH (e)-[:ABOUT]->(i:Issue)
WITH e, collect(DISTINCT p.name) AS attendees, collect(DISTINCT i.id) AS tickets
RETURN e{.id, .title, .date, .day, .time, .description, attendees: attendees, tickets: tickets} AS event`;

interface IssueRef { id: string; title?: string; status?: string; eta?: string }
export interface IssueRow {
  issue: IssueRef; owner?: string | null; blocker?: IssueRef | null; blockerOwner?: string | null;
  project?: string | null; customer?: string | null; meetings?: { title: string; day?: string; time?: string; attendees?: string[] }[];
}
export interface GraphView {
  emails: { id: string; subject?: string; sender?: string; person?: string; mentions: string[] }[];
  customers: { customer: string; contacts: string[]; projects: string[] }[];
  events: unknown[];
  issues: Record<string, unknown>[];
}

const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) as T;
const issueView = (i: IssueRef, owner?: string | null) => clean({ id: i.id, title: i.title, status: i.status, eta: when(i.eta), owner });

/** Pure shaping of the walked rows into the object the tool returns. Exported for tests. */
export function shapeGraph(rows: { events: { event: unknown }[]; issues: IssueRow[]; customers: GraphView["customers"]; emails: GraphView["emails"] }): GraphView {
  const byId = new Map<string, Record<string, unknown> & { blockedBy: unknown[] }>();
  for (const r of rows.issues) {
    const view = byId.get(r.issue.id) ?? { ...issueView(r.issue, r.owner), project: r.project ?? undefined, customer: r.customer ?? undefined, discussedIn: r.meetings?.length ? r.meetings : undefined, blockedBy: [] };
    if (r.blocker) view.blockedBy.push(issueView(r.blocker, r.blockerOwner));
    byId.set(r.issue.id, view);
  }
  return {
    emails: rows.emails.map((e) => clean(e) as GraphView["emails"][number]).map((e) => ({ ...e, mentions: e.mentions ?? [] })),
    customers: rows.customers,
    events: rows.events.map((e) => e.event),
    issues: [...byId.values()].map(clean),
  };
}

/** LINK the starts to nodes, then WALK around them. Returns null when nothing in the graph matches. */
export async function exploreGraph(starts: string[]): Promise<GraphView | null> {
  const linked = await run<{ label: string; keys: string[] }>(LINK, { starts });
  const keys = (label: string): string[] => linked.find((r) => r.label === label)?.keys ?? [];
  const ids = { events: keys("Event"), issues: keys("Issue"), emails: keys("Email"), customers: keys("Customer"), projects: keys("Project") };
  if (!Object.values(ids).some((k) => k.length)) return null;
  const [issues, customers, emails, events] = await Promise.all([
    run<IssueRow>(ISSUES, ids), run<GraphView["customers"][number]>(CUSTOMERS, ids), run<GraphView["emails"][number]>(EMAILS, ids), run<{ event: unknown }>(EVENTS, ids),
  ]);
  return shapeGraph({ events, issues, customers, emails });
}
