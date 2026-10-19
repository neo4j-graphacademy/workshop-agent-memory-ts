// STAGE 6: withhold facts from untrusted sources when the question is sensitive (payments, accounts).
// Pure functions so the gate can be unit-tested; query_memory calls filterFacts(), and search_emails applies the same test to its results.
import { config } from "../../../workshop.config.js";

const SENSITIVE = /\b(pay|paid|payment|payments|account|accounts|bank|iban|sort\s*code|remit|remittance|wire|transfer|invoice|invoices)\b/i;

export const isSensitiveQuestion = (text: string) => SENSITIVE.test(text);

export interface TrustedFact { text: string; trust?: string | null; source?: string | null }

export function filterFacts<T extends TrustedFact>(facts: T[], questionText: string, enabled = config.trustFilter): { kept: T[]; withheld: T[] } {
  if (!enabled || !isSensitiveQuestion(questionText)) return { kept: facts, withheld: [] as T[] };
  const withheld = facts.filter((f) => f.trust === "low");
  return { kept: facts.filter((f) => f.trust !== "low"), withheld };
}

export const withheldNotice = (n: number) =>
  n > 0 ? `${n} stored fact(s) were withheld: they come from an untrusted source and this question is about payments or accounts. Verify through a trusted channel.` : undefined;
