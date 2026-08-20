import {
  type ExternalMemoryProviderName,
  type LearningConfig,
} from "./config.ts";
import type { UnknownRecord } from "./shared.ts";

type ExternalResult = {
  provider: ExternalMemoryProviderName;
  results: UnknownRecord[];
};

export class ExternalMemoryAdapter {
  private honchoClient: unknown;

  constructor(
    private readonly config: LearningConfig,
    private readonly projectRoot: string,
  ) {}

  status(): UnknownRecord {
    const provider = this.config.externalMemoryProvider;
    const configured =
      provider === "builtin" ||
      (provider === "mem0" &&
        Boolean(process.env.MEM0_API_KEY || process.env.MEM0_HOST)) ||
      (provider === "honcho" &&
        Boolean(process.env.HONCHO_API_KEY || process.env.HONCHO_URL));
    return {
      provider,
      configured,
      autoSync: this.config.externalMemoryAutoSync,
      topK: this.config.externalMemoryTopK,
      timeoutMs: this.config.externalMemoryTimeoutMs,
      credentialSource:
        provider === "mem0"
          ? "MEM0_API_KEY / MEM0_HOST"
          : provider === "honcho"
            ? "HONCHO_API_KEY / HONCHO_URL"
            : "none",
    };
  }

  async search(query: string): Promise<ExternalResult> {
    const provider = this.config.externalMemoryProvider;
    if (provider === "builtin") return { provider, results: [] };
    if (provider === "mem0")
      return { provider, results: await this.searchMem0(query) };
    return { provider, results: await this.searchHoncho(query) };
  }

  async syncTurn(
    sessionID: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    if (
      !this.config.externalMemoryAutoSync ||
      this.config.externalMemoryProvider === "builtin"
    )
      return;
    if (!userContent.trim() || !assistantContent.trim()) return;
    if (this.config.externalMemoryProvider === "mem0") {
      await this.syncMem0(sessionID, userContent, assistantContent);
      return;
    }
    await this.syncHoncho(sessionID, userContent, assistantContent);
  }

  private async searchMem0(query: string): Promise<UnknownRecord[]> {
    const host = process.env.MEM0_HOST?.replace(/\/$/u, "");
    const apiKey = process.env.MEM0_API_KEY ?? "";
    if (!host && !apiKey)
      throw new Error("Mem0 is not configured; set MEM0_API_KEY or MEM0_HOST");
    const userID = process.env.MEM0_USER_ID || "opencode-user";
    const response = await this.requestJSON(
      host ? `${host}/search` : "https://api.mem0.ai/v3/memories/search/",
      host
        ? {
            query,
            user_id: userID,
            agent_id: process.env.MEM0_AGENT_ID || "opencode",
          }
        : {
            query,
            filters: { user_id: userID },
            top_k: this.config.externalMemoryTopK,
          },
      host ? { "X-API-Key": apiKey } : { Authorization: `Token ${apiKey}` },
    );
    const raw = Array.isArray(response)
      ? response
      : response &&
          typeof response === "object" &&
          Array.isArray((response as UnknownRecord).results)
        ? ((response as UnknownRecord).results as unknown[])
        : [];
    return raw
      .slice(0, this.config.externalMemoryTopK)
      .map(normalizeExternalItem);
  }

  private async syncMem0(
    sessionID: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const host = process.env.MEM0_HOST?.replace(/\/$/u, "");
    const apiKey = process.env.MEM0_API_KEY ?? "";
    if (!host && !apiKey)
      throw new Error("Mem0 is not configured; set MEM0_API_KEY or MEM0_HOST");
    const userID = process.env.MEM0_USER_ID || "opencode-user";
    await this.requestJSON(
      host ? `${host}/memories` : "https://api.mem0.ai/v3/memories/add/",
      {
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        ],
        user_id: userID,
        agent_id: process.env.MEM0_AGENT_ID || "opencode",
        run_id: sessionID,
        metadata: {
          project_root: this.projectRoot,
          source: "opencode-continuous-learning",
        },
      },
      host ? { "X-API-Key": apiKey } : { Authorization: `Token ${apiKey}` },
    );
  }

  private async searchHoncho(query: string): Promise<UnknownRecord[]> {
    const client = await this.honcho();
    const user = await client.peer(
      process.env.HONCHO_USER_ID || "opencode-user",
    );
    const messages = await user.search(query, {
      limit: this.config.externalMemoryTopK,
    });
    return messages.map((message) => ({
      id: message.id,
      content: message.content,
      session_id: message.sessionId,
      peer_id: message.peerId,
      created_at: message.createdAt,
    }));
  }

  private async syncHoncho(
    sessionID: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const client = await this.honcho();
    const user = await client.peer(
      process.env.HONCHO_USER_ID || "opencode-user",
    );
    const assistant = await client.peer(
      process.env.HONCHO_AGENT_ID || "opencode-assistant",
    );
    const session = await client.session(`opencode-${sessionID}`, {
      peers: [user, assistant],
    });
    await session.addMessages([
      user.message(userContent),
      assistant.message(assistantContent),
    ]);
  }

  private async honcho(): Promise<import("@honcho-ai/sdk").Honcho> {
    if (this.honchoClient)
      return this.honchoClient as import("@honcho-ai/sdk").Honcho;
    const { Honcho } = await import("@honcho-ai/sdk");
    this.honchoClient = new Honcho({
      apiKey: process.env.HONCHO_API_KEY,
      baseURL: process.env.HONCHO_URL,
      workspaceId:
        process.env.HONCHO_WORKSPACE_ID || "opencode-continuous-learning",
      timeout: this.config.externalMemoryTimeoutMs,
      maxRetries: 1,
    });
    return this.honchoClient as import("@honcho-ai/sdk").Honcho;
  }

  private async requestJSON(
    url: string,
    body: UnknownRecord,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.externalMemoryTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `External memory request failed (${response.status}): ${text.slice(0, 500)}`,
        );
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeExternalItem(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object") return { value: String(value) };
  const item = value as UnknownRecord;
  return {
    id: item.id,
    memory: item.memory ?? item.content ?? item.text,
    score: item.score,
    created_at: item.created_at ?? item.createdAt,
    metadata: item.metadata,
  };
}
