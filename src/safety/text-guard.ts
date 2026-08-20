import type { MemoryTarget } from "../config/schema.ts";

const MEMORY_HEADERS: Record<MemoryTarget, string> = {
  memory: "# Persistent Memory",
  user: "# User Profile",
  project: "# Project Memory",
};

const THREAT_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|prompts)/iu,
  /(?:reveal|print|exfiltrate)[\s\S]{0,48}(?:system\s+prompt|password|secret|token|api\s*key)/iu,
  /(?:send|upload|exfiltrate)[\s\S]{0,48}(?:password|secret|token|api\s*key)/iu,
  /\b(?:sk|rk|pk)-[a-z0-9_-]{16,}\b/iu,
  /\bgh[opusr]_[a-z0-9]{20,}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /<\/persistent-learning-snapshot\s*>/iu,
  /[\u202a-\u202e\u2066-\u2069]/u,
];

export function normalizeOneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function assertSafePersistentText(value: string, label: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, "")
    .trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(
        `${label} was rejected by the persistent-content safety scan`,
      );
    }
  }
  return normalized;
}

export { MEMORY_HEADERS };
