import { createHash } from "node:crypto";

export function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export function tokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
  const compactCJK = [...normalized].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  for (let index = 0; index + 1 < compactCJK.length; index += 1) {
    result.add(`${compactCJK[index]}${compactCJK[index + 1]}`);
  }
  return result;
}

export function intersectionSize(
  left: Set<string>,
  right: Set<string>,
): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}
