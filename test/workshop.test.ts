// npm test: no LLM and no Neo4j calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { config, allowedRecipients } from "../workshop.config.js";
import { loadSeed, loadState, resetState, seedText, withWeekday } from "../src/workshop/nsuite/state.js";
import { STATE_FILE } from "../src/workshop/paths.js";
import { checkSeed } from "../src/workshop/nsuite/seedCheck.js";
import { applyDelta, mapToolResult, POLE_LABEL, SUBTYPE_LABEL } from "../src/workshop/hooks/mapToolResults.js";
import { approvals, checkApproval } from "../src/workshop/processors/approvalGate.js";
import { checkRecipient } from "../src/workshop/processors/recipientAllowlist.js";
import { filterFacts, isSensitiveQuestion } from "../src/workshop/processors/trustFilter.js";
import { resolveProvenance } from "../src/workshop/graph/provenance.js";
import { renderRules } from "../src/workshop/processors/pinnedRules.js";
import { shapeGraph } from "../src/workshop/graph/explore.js";
import { emailEmbeddingText } from "../src/workshop/retrieval/emails.js";
import { checkCypher } from "../src/workshop/tools/graph.js";
import { presets, rewriteConfigSource } from "../src/workshop/harness/presets.js";
import { execute, specs } from "../src/workshop/tools/index.js";
import { show_extraction_prompt } from "../src/workshop/tools/memory.js";
import { extractionInstructions } from "../src/workshop/hooks/extractUserStatements.js";
import { runtime } from "../src/workshop/runtime.js";
import { runGuards, installGuards, clearGuards } from "../src/workshop/tools/guards.js";
import { appendAudit, readAudit } from "../src/workshop/nsuite/audit.js";
import { renderAbout, isKnown, ONBOARDING_NUDGE } from "../src/workshop/processors/aboutUser.js";
import { poleSchema, resolveRelations, keyOf } from "../src/workshop/graph/pole.js";
import { buildExtractionSchema, ontology, renderOntologyForPrompt, validateOntology } from "../src/workshop/graph/ontology.js";
import { renderApocSchema, renderOntologySchema } from "../src/workshop/graph/schema.js";
void applyDelta;

// ── seed and state ──────────────────────────────────────────────────────────
test("seed invariants hold", () => assert.deepEqual(checkSeed(loadSeed()), []));

test("reset restores byte-identical state after mutations", async () => {
  resetState();
  assert.equal(readFileSync(STATE_FILE, "utf8"), seedText());
  await execute(specs.delete_email, { id: "e-001" });
  assert.equal(loadState().emails.length, 39);
  resetState();
  assert.equal(readFileSync(STATE_FILE, "utf8"), seedText());
  assert.equal(readAudit().length, 0);
});

test("withWeekday is computed in code", () => assert.equal(withWeekday("2025-06-12"), "Thursday 2025-06-12"));

// ── MODE switch ─────────────────────────────────────────────────────────────
test("mock mode really deletes; dry-run does not; real throws not-configured", async () => {
  resetState();
  const saved = config.mode;
  try {
    config.mode = "mock";
    assert.deepEqual((await execute(specs.delete_email, { id: "e-002" })).result, { deleted: true, remaining: 39 });
    config.mode = "dry-run";
    const dry = await execute(specs.delete_email, { id: "e-003" });
    assert.equal(dry.outcome, "dry-run");
    assert.equal(loadState().emails.length, 39);
    config.mode = "real";
    const real = await execute(specs.delete_email, { id: "e-004" });
    assert.equal(real.outcome, "error");
    assert.match(String((real.result as any).error), /not configured/);
    assert.equal(loadState().emails.length, 39);
    // reads are always allowed
    assert.equal(((await execute(specs.list_emails, {})).result as any).count, 39);
  } finally {
    config.mode = saved;
    resetState();
  }
});

test("audit log records every call and is append-only", () => {
  resetState();
  appendAudit({ tool: "x", args: {}, write: false, mode: "mock", outcome: "ok" });
  appendAudit({ tool: "y", args: {}, write: true, mode: "mock", outcome: "ok" });
  assert.deepEqual(readAudit().map((e) => e.seq), [1, 2]);
  resetState();
});

test("Sam is not reachable from the question's words in any tool output about him", async () => {
  const sam = ((await execute(specs.list_emails, { sender: "sam@" })).result as any).emails;
  assert.equal(sam.length, 1);
  assert.doesNotMatch(JSON.stringify(sam), /billing|export|review/i);
  assert.doesNotMatch(JSON.stringify((await execute(specs.get_issue, { id: "ENG-139" })).result), /billing|export|review/i);
});

// ── mappers ─────────────────────────────────────────────────────────────────
test("mapper: get_events -> Event, ATTENDED_BY, ABOUT", async () => {
  const out = (await execute(specs.get_events, { date: "Tuesday" })).result;
  const d = mapToolResult("get_events", out, loadSeed().people);
  assert.ok(d.nodes.some((n) => n.label === "Event" && n.key === "ev-002"));
  const rels = d.rels.map((r) => `${r.from.key}-${r.type}->${r.to.key}`);
  assert.ok(rels.includes("ev-002-ATTENDED_BY->Priya"));
  assert.ok(rels.includes("ev-002-ATTENDED_BY->Dana"));
  assert.ok(rels.includes("ev-002-ABOUT->ENG-142"));
  assert.ok(!rels.some((r) => r.includes("Sam")), "Sam is not an attendee");
});

test("mapper: get_issue -> OWNED_BY and BLOCKED_BY", async () => {
  const d = mapToolResult("get_issue", (await execute(specs.get_issue, { id: "ENG-142" })).result);
  const rels = d.rels.map((r) => `${r.from.key}-${r.type}->${r.to.key}`);
  assert.deepEqual(rels.sort(), ["ENG-142-BLOCKED_BY->ENG-139", "ENG-142-OWNED_BY->Priya"]);
});

test("read_email returns headers and the mapper links TO, CC and REPLY_TO", async () => {
  const mail = (await execute(specs.read_email, { id: "e-013" })).result as any;
  assert.match(mail.from, /^Dana Whitfield <dana@/);
  assert.ok(mail.to.some((t: string) => t.includes("adam@")) && mail.cc.some((c: string) => c.includes("priya@")));
  const rels = mapToolResult("read_email", mail, loadSeed().people).rels.map((r) => `${r.type}->${r.to.key}`);
  assert.ok(rels.includes("SENT_BY->Dana") && rels.includes("TO->Adam") && rels.includes("CC->Priya") && rels.includes("REPLY_TO->e-012"));
});

test("mapper: emails link sender to known people only; unknown tools map to nothing", async () => {
  const d = mapToolResult("list_emails", (await execute(specs.list_emails, {})).result, loadSeed().people);
  assert.equal(d.nodes.filter((n) => n.label === "Email").length, 40);
  assert.ok(d.rels.some((r) => r.type === "SENT_BY" && r.to.key === "Sam"));
  assert.deepEqual(mapToolResult("remember_fact", { remembered: true }), { nodes: [], rels: [] });
});

test("mapper: an email names a customer and project, and the project leads to its tickets", async () => {
  const seed = loadSeed();
  const mail = (await execute(specs.read_email, { id: "e-038" })).result;
  const d = mapToolResult("read_email", mail, seed.people, seed);
  const rels = d.rels.map((r) => `${r.from.key} ${r.type} ${r.to.key}`);
  assert.ok(rels.includes("e-038 MENTIONS Contoso"));
  assert.ok(rels.includes("Atlas FOR Contoso") && rels.includes("ENG-142 PART_OF Atlas"));
  assert.ok(!rels.some((r) => r.includes("MENTIONS Fabrikam")), "an email only mentions what its text names");
  // Without the dictionaries the mapper does what it did before: no customers, no projects.
  assert.ok(!mapToolResult("read_email", mail, seed.people).rels.some((r) => r.type === "MENTIONS"));
});

test("mapper: Dana works for Contoso by email domain, and tickets join their project", async () => {
  const seed = loadSeed();
  const dana = (await execute(specs.read_email, { id: "e-011" })).result;
  const rels = mapToolResult("read_email", dana, seed.people, seed).rels.map((r) => `${r.from.key} ${r.type} ${r.to.key}`);
  assert.ok(rels.includes("Dana WORKS_FOR Contoso"));
  assert.ok(!rels.some((r) => r.includes("MENTIONS")), "Dana's emails never name a customer or project");
  const issue = mapToolResult("get_issue", (await execute(specs.get_issue, { id: "ENG-142" })).result, seed.people, seed).rels.map((r) => `${r.from.key} ${r.type} ${r.to.key}`);
  assert.ok(issue.includes("ENG-142 PART_OF Atlas") && issue.includes("Atlas FOR Contoso"));
});

test("explore_graph returns customers, projects and the meeting a ticket came up in as data", () => {
  const view = shapeGraph({
    events: [],
    issues: [{
      issue: { id: "ENG-142", title: "Billing export fails", status: "in_progress" }, owner: "Priya", project: "Atlas", customer: "Contoso",
      meetings: [{ title: "Billing review", day: "Tuesday", time: "14:00", attendees: ["Priya", "Dana"] }],
      blocker: { id: "ENG-139", title: "Migrate invoices table", eta: "2025-06-12" }, blockerOwner: "Sam",
    }],
    customers: [{ customer: "Contoso", contacts: ["Dana"], projects: ["Atlas"] }],
    emails: [{ id: "e-038", subject: "Invoice INV-2041 is 38 days past due", mentions: ["Contoso", "Atlas"] }],
  });
  assert.deepEqual(view.emails[0].mentions, ["Contoso", "Atlas"]);
  assert.deepEqual(view.customers[0], { customer: "Contoso", contacts: ["Dana"], projects: ["Atlas"] });
  const [issue] = view.issues as any[];
  assert.equal(issue.project, "Atlas");
  assert.equal(issue.customer, "Contoso");
  assert.equal(issue.discussedIn[0].title, "Billing review");
  assert.deepEqual(issue.blockedBy, [{ id: "ENG-139", title: "Migrate invoices table", eta: "Thursday 2025-06-12", owner: "Sam" }], "a bare ISO date gets its weekday from code");
  assert.doesNotThrow(() => JSON.stringify(view), "the result is plain JSON");
});

test("explore_graph merges the rows of a ticket with two blockers and leaves out empty fields", () => {
  const view = shapeGraph({
    events: [], customers: [], emails: [],
    issues: [
      { issue: { id: "ENG-1", title: "A" }, blocker: { id: "ENG-2" }, blockerOwner: "Sam" },
      { issue: { id: "ENG-1", title: "A" }, blocker: { id: "ENG-3" }, blockerOwner: null },
    ],
  });
  const [issue] = view.issues as any[];
  assert.equal(view.issues.length, 1);
  assert.deepEqual(issue.blockedBy.map((b: any) => b.id), ["ENG-2", "ENG-3"]);
  assert.ok(!("owner" in issue) && !("project" in issue), "unknown values are not sent to the model");
});

test("an email is embedded with its headers and its whole body", () => {
  const text = emailEmbeddingText({ id: "e-040", from: "Tailspin Toys Accounts Payable <payables@tailspin-customer.example>", to: ["adam@northwind.test"], cc: [], subject: "Re: Beacon invoice, transfer delayed", body: "quarter-end approvals" });
  assert.match(text, /^Email from Tailspin Toys Accounts Payable.*to adam@northwind.test: Re: Beacon invoice, transfer delayed\nquarter-end approvals$/s);
});

test("query_graph: only one read-only query over the data graph gets through", () => {
  assert.equal(checkCypher("MATCH (i:Issue) WHERE NOT EXISTS { (:Event)-[:ABOUT]->(i) } RETURN i.id"), null);
  assert.equal(checkCypher("MATCH (i:Issue) WHERE i.title CONTAINS 'set up' RETURN i.id;"), null, "words inside strings are not keywords");
  assert.match(checkCypher("MATCH (i:Issue) DETACH DELETE i")!, /read-only/);
  assert.match(checkCypher("MATCH (i:Issue) SET i.status = 'done'")!, /read-only/);
  assert.match(checkCypher("MATCH (f:Fact) RETURN f.text")!, /Fact label/);
  assert.match(checkCypher("MATCH (r:Rule) RETURN r")!, /Rule label/);
  assert.match(checkCypher("MATCH (i:Issue) RETURN i; MATCH (n) DETACH DELETE n")!, /one statement/i);
  assert.match(checkCypher("CALL db.labels()")!, /start with/);
  assert.match(checkCypher("  ")!, /No query/);
});

// ── gates ───────────────────────────────────────────────────────────────────
test("approval gate: blocks with a Rule, passes without, passes after human approval", () => {
  const state = { ...approvals, pending: [] as any[], granted: new Set<string>(), seq: 0, approve: approvals.approve, reset: approvals.reset };
  const rules = [{ tool: "delete_email", mode: "require_approval" }];
  assert.equal(checkApproval("delete_email", { id: "e-1" }, [], state), null);
  const block = checkApproval("delete_email", { id: "e-1" }, rules, state)!;
  assert.equal(block.status, "approval_required");
  assert.equal(checkApproval("delete_email", { id: "e-2" }, rules, state)!.approval_id, block.approval_id, "one approval per tool");
  assert.equal(checkApproval("send_message", {}, rules, state), null, "other tools unaffected");
  state.approve.call(state);
  assert.equal(checkApproval("delete_email", { id: "e-3" }, rules, state), null);
});

test("approval gate: forbid rule can never be approved", () => {
  const state = { ...approvals, pending: [] as any[], granted: new Set(["send_message"]), seq: 0 };
  assert.equal(checkApproval("send_message", {}, [{ tool: "send_message", mode: "forbid" }], state)!.status, "blocked");
});

test("recipient allowlist", () => {
  assert.equal(checkRecipient("send_message", { to: allowedRecipients[0] }), null);
  assert.equal(checkRecipient("send_message", { to: `Priya <${allowedRecipients[0].toUpperCase()}>` }), null);
  assert.equal(checkRecipient("send_message", { to: "dana@contoso-customer.example" })!.status, "blocked");
  assert.equal(checkRecipient("delete_email", { to: "anyone" }), null);
});

test("guards run inside tool execution, fail closed, and block is not bypassable by args", async () => {
  clearGuards();
  installGuards([() => ({ status: "blocked", gate: "t", tool: "x", message: "no" })]);
  assert.equal((await runGuards({ tool: "x", args: {} }))!.gate, "t");
  clearGuards();
  installGuards([() => { throw new Error("boom"); }]);
  assert.equal((await runGuards({ tool: "x", args: {} }))!.gate, "guard_error");
  clearGuards();
});

// ── provenance and trust filter ─────────────────────────────────────────────
test("trust filter withholds low-trust facts for payment questions only", () => {
  const facts = [{ text: "pay to 00-00-00", trust: "low" }, { text: "Dana is a customer", trust: "high" }];
  assert.equal(isSensitiveQuestion("Where do I pay Acme?"), true);
  assert.equal(isSensitiveQuestion("Who owns ENG-142?"), false);
  assert.equal(filterFacts(facts, "Where do I pay Acme?", true).kept.length, 1);
  assert.equal(filterFacts(facts, "Who owns ENG-142?", true).kept.length, 2);
  assert.equal(filterFacts(facts, "Where do I pay Acme?", false).kept.length, 2);
});

test("provenance is resolved by code from emails actually read", () => {
  const acme = loadSeed().emails.find((e) => e.sender.startsWith("accounts@acme"))!;
  runtime.emailsRead = new Map([[acme.id, { id: acme.id, sender: acme.sender, subject: acme.subject, body: acme.body }]]);
  runtime.userText = "what is on my calendar?";
  const p = resolveProvenance("Acme invoices are paid to account 00-00-00, per the vendor email.");
  assert.deepEqual([p.source, p.trust, p.emailId], ["email:external", "low", acme.id]);
  assert.equal(resolveProvenance("The moon is made of cheese and also of other things entirely").source, "agent:unverified");
  runtime.userText = "Please remember that Dana prefers email over phone calls.";
  assert.equal(resolveProvenance("Dana prefers email over phone calls").source, "user");
  runtime.emailsRead = new Map();
});

// ── rendering and presets ───────────────────────────────────────────────────
test("pinned rules text", () => {
  assert.match(renderRules([{ key: "k", tool: "delete_email", mode: "require_approval", source: "user", turn: 1, text: "never delete" }]), /delete_email.*approval/s);
});

test("presets: stage 0 is fully off and each stage only adds", () => {
  assert.ok(Object.entries(presets[0]).every(([k, v]) => ["mode", "maxSteps", "historyWindow", "retrieval"].includes(k) || v === false));
  assert.equal(presets[1].history, true);
  assert.equal(presets[5].approvalGate, true);
  assert.equal(presets[6].trustFilter, true);
  assert.equal(presets[3].retrieval, "none");
});

test("presets rewrite workshop.config.ts in place and keep comments", () => {
  const src = readFileSync(new URL("../workshop.config.ts", import.meta.url), "utf8");
  const out = rewriteConfigSource(src, presets[6]);
  assert.match(out, /^\s{2}approvalGate: true,/m);
  assert.match(out, /^\s{2}retrieval: "both",/m);
  assert.equal(out.split("\n").filter((l) => l.trim().startsWith("//")).length, src.split("\n").filter((l) => l.trim().startsWith("//")).length);
  assert.equal(rewriteConfigSource(out, presets[0]).replace(/\s+/g, " "), rewriteConfigSource(src, presets[0]).replace(/\s+/g, " "));
});

// ── onboarding and POLE+O ───────────────────────────────────────────────────
test("about-user block renders the profile; an empty profile is not known", () => {
  const p = { name: "Sam", funFact: "rode a camel", preferences: ["short summaries"], links: [{ rel: "LIVES_IN", type: "Location", name: "London" }] };
  const text = renderAbout(p);
  assert.match(text, /Name: Sam/);
  assert.match(text, /lives in: London/);
  assert.match(text, /Preferences: short summaries/);
  assert.match(text, /Fun fact: rode a camel/);
  assert.equal(isKnown(p), true);
  assert.equal(isKnown(null), false);
  assert.equal(isKnown({ name: null, funFact: null, preferences: [], links: [] }), false);
  assert.match(ONBOARDING_NUDGE, /where they live/);
  assert.match(ONBOARDING_NUDGE, /language/);
});

test("POLE+O schema accepts known types and rejects unknown ones", () => {
  const ok = { user: { preferences: [] }, entities: [{ type: "Location", name: "London" }], relations: [{ from: "user", type: "LIVES_IN", to: "London" }] };
  assert.equal(poleSchema.safeParse(ok).success, true);
  assert.equal(poleSchema.safeParse({ ...ok, entities: [{ type: "Planet", name: "Mars" }] }).success, false);
  assert.equal(poleSchema.safeParse({ ...ok, relations: [{ from: "user", type: "DROP_ALL", to: "London" }] }).success, false);
});

test("entities carry a subtype that must belong to their type", () => {
  const base = { user: { preferences: [] }, relations: [] };
  assert.equal(poleSchema.safeParse({ ...base, entities: [{ type: "Person", subtype: "Employee", name: "Priya" }] }).success, true);
  assert.equal(poleSchema.safeParse({ ...base, entities: [{ type: "Person", name: "Priya" }] }).success, true);
  assert.equal(poleSchema.safeParse({ ...base, entities: [{ type: "Person", subtype: "Customer", name: "Priya" }] }).success, false);
  assert.equal(poleSchema.safeParse({ ...base, entities: [{ type: "Person", subtype: "Wizard", name: "Priya" }] }).success, false);
});

test("show_extraction_prompt returns the prompt the extractor uses, with the ontology in it", async () => {
  const { result } = await execute(show_extraction_prompt, {});
  assert.equal((result as { prompt: string }).prompt, extractionInstructions());
  assert.match((result as { prompt: string }).prompt, /Employee/);
  assert.match((result as { prompt: string }).prompt, /Return rules/);
});

test("the extraction schema and prompt follow the ontology, so a new subtype needs no other change", () => {
  const o = structuredClone(ontology);
  o.entities.Person.subtypes.Contractor = "Paid by the hour";
  const schema = buildExtractionSchema(validateOntology(o));
  assert.equal(schema.safeParse({ user: { preferences: [] }, relations: [], entities: [{ type: "Person", subtype: "Contractor", name: "Sam" }] }).success, true);
  assert.match(renderOntologyForPrompt(o), /Contractor: Paid by the hour/);
  assert.match(renderOntologyForPrompt(), /Employee/);
});

test("an ontology with unsafe or clashing names is rejected", () => {
  const withType = (t: string) => ({ ...ontology, entities: { ...ontology.entities, [t]: { description: "x", subtypes: {} } } });
  assert.throws(() => validateOntology(withType("Bad Label) DETACH DELETE n //")), /letters, numbers/);
  assert.throws(() => validateOntology(withType("Fact")), /used by the workshop/);
  assert.throws(() => validateOntology({ ...ontology, entities: { ...ontology.entities, Location: { description: "x", subtypes: { Person: "clashes with a type" } } } }), /defined twice/);
  assert.throws(() => validateOntology({ ...ontology, relations: { ...ontology.relations, bad: { description: "x", from: [], to: [] } } }), /UPPER_SNAKE_CASE/);
  assert.throws(() => validateOntology({ ...ontology, relations: { X: { description: "x", from: ["Planet"], to: [] } } }), /not an entity type/);
});

test("every tool-result label is a type or subtype in the ontology", () => {
  const known = new Set([...Object.keys(ontology.entities), ...Object.values(ontology.entities).flatMap((e) => Object.keys(e.subtypes))]);
  for (const [label, pole] of Object.entries(POLE_LABEL)) {
    assert.ok(known.has(pole), pole);
    if (label !== pole) assert.ok(known.has(label), `${label} should be a subtype in ontology.ts`);
  }
  for (const sub of Object.values(SUBTYPE_LABEL)) assert.ok(known.has(sub!), sub);
});

test("the graph schema is rendered from APOC output, hides agent memory, and falls back to the ontology", () => {
  const meta: any = {
    Person: { type: "node", properties: { name: { type: "STRING" } }, relationships: { WORKS_AT: { direction: "out", labels: ["Organization"] }, ABOUT: { direction: "in", labels: ["Event"] } } },
    Organization: { type: "node", properties: { name: { type: "STRING" } }, relationships: {} },
    Fact: { type: "node", properties: { text: { type: "STRING" } }, relationships: {} },
    WORKS_AT: { type: "relationship" },
  };
  const text = renderApocSchema(meta);
  assert.match(text, /\(:Person \{name\}\)/);
  assert.match(text, /\(:Person\)-\[:WORKS_AT\]->\(:Organization\)/);
  assert.doesNotMatch(text, /Fact/);
  assert.doesNotMatch(text, /ABOUT/);
  assert.equal(renderApocSchema({}), "");
  assert.match(renderOntologySchema(), /\(:Person:Employee\)/);
});

test("relations resolve to typed endpoints; unknown endpoints are dropped; people share the first-name key", () => {
  const entities = [{ type: "Location" as const, name: "London" }, { type: "Person" as const, name: "Priya Shah" }];
  const rels = resolveRelations(entities, [
    { from: "user", type: "LIVES_IN", to: "London" },
    { from: "user", type: "KNOWS", to: "priya shah" },
    { from: "user", type: "OWNS", to: "a boat" },
  ]);
  assert.equal(rels.length, 2);
  assert.deepEqual(keyOf(rels[1].to), { label: "Person", prop: "name", value: "Priya" });
  assert.deepEqual(keyOf({ label: "Event", name: "London Marathon" }), { label: "Event", prop: "id", value: "user-event:london-marathon" });
});

test("presets: onboarding arrives with stage 3", () => {
  assert.equal(presets[2].onboarding, false);
  assert.equal(presets[3].onboarding, true);
});

test("every tool-result label maps to a POLE+O label", () => {
  assert.deepEqual(POLE_LABEL, { Email: "Object", Event: "Event", Issue: "Object", Person: "Person", Customer: "Organization", Project: "Object" });
});
