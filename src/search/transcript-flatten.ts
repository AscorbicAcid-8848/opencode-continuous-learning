import type { TranscriptItem } from "../review/transcript.ts";
import type { UnknownRecord } from "../shared/types.ts";

export interface IndexedMessage {
  id: string;
  session_id: string;
  ordinal: number;
  role: string;
  content: string;
}

export function excerpt(content: string, query = "", limit = 600): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) return compact;
  const needle = query.trim().toLocaleLowerCase();
  const hit = needle ? compact.toLocaleLowerCase().indexOf(needle) : -1;
  const start = hit < 0 ? 0 : Math.max(0, hit - Math.floor(limit / 3));
  const end = Math.min(compact.length, start + limit);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function transcriptMessages(items: TranscriptItem[]): IndexedMessage[] {
  const messages: IndexedMessage[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.text.trim()) {
      messages.push({
        id: item.id,
        session_id: "",
        ordinal,
        role: item.role,
        content: item.text.trim(),
      });
      ordinal += 1;
    }
    for (const [toolIndex, call] of item.toolCalls.entries()) {
      const chunks = [
        `tool=${call.name}`,
        `status=${call.status}`,
        call.input === undefined ? "" : `input=${safeJSONString(call.input)}`,
        call.output ? `output=${call.output}` : "",
      ].filter(Boolean);
      messages.push({
        id: `${item.id}:tool:${toolIndex}`,
        session_id: "",
        ordinal,
        role: "tool",
        content: chunks.join("\n"),
      });
      ordinal += 1;
    }
  }
  return messages;
}

function safeJSONString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type { UnknownRecord };
