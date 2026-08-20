import { truncate } from "../shared/utils.ts";

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: Array<{
    name: string;
    status: string;
    input?: unknown;
    output?: string;
  }>;
}

export function renderTranscript(
  items: TranscriptItem[],
  maxCharacters: number,
): string {
  const chunks = items.map((item) => {
    const lines = [
      `[${item.role.toUpperCase()} ${item.id}]`,
      item.text || "(no text)",
    ];
    for (const call of item.toolCalls) {
      const input =
        call.input === undefined
          ? ""
          : ` input=${truncate(JSON.stringify(call.input), 1_500)}`;
      const output = call.output ? `\n${truncate(call.output, 2_500)}` : "";
      lines.push(`[TOOL ${call.name} ${call.status}]${input}${output}`);
    }
    return lines.join("\n");
  });
  const selected: string[] = [];
  let used = 0;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = truncate(chunks[index], maxCharacters);
    if (selected.length && used + chunk.length + 2 > maxCharacters) break;
    selected.unshift(chunk);
    used += chunk.length + 2;
  }
  return selected.join("\n\n");
}
