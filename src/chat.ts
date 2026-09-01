import { BlazingAgents, type BlazingAgentsOptions } from "@blazingagents/sdk";
import { resolveAgent } from "./agent-resolution.ts";
import { BlazingChatTransport } from "./chat-transport.ts";
import type { ResolvedConfiguration } from "./config.ts";
import { isAdminAgentId } from "./contracts.ts";
import { runTerminalTui, type TuiLoader } from "./tui.ts";

export class ChatOperationalError extends Error {
  override name = "ChatOperationalError";
}

export async function executeChat({
  agentSelector,
  apiKey,
  configuration,
  fetch,
  loadTui = () => import("@ai-sdk/tui"),
  sessionId,
  stdout,
  terminal = process.stdin,
}: {
  agentSelector: string;
  apiKey: string;
  configuration: ResolvedConfiguration;
  fetch?: BlazingAgentsOptions["fetch"];
  loadTui?: TuiLoader;
  sessionId?: string;
  stdout: (text: string) => void;
  terminal?: {
    isTTY?: boolean;
    pause: () => unknown;
    setRawMode?: (mode: boolean) => unknown;
  };
}): Promise<void> {
  const client = new BlazingAgents({
    apiKey,
    baseUrl: configuration.baseUrl,
    ...(fetch ? { fetch } : {}),
  });
  const { agents } = await client.agents.list();
  const agent = resolveAgent(agentSelector, agents);
  if (isAdminAgentId(agent.id)) {
    throw new ChatOperationalError(
      "The Admin Agent is available only through BA Assist. Use ba assist instead."
    );
  }
  if (sessionId) {
    await client.sessions.messages(agent.id, sessionId, { limit: 1 });
  }

  const transport = new BlazingChatTransport({
    agentId: agent.id,
    client,
    sessionId,
  });
  await runTerminalTui({
    loadTui,
    options: {
      responseStatistics: "outputTokenCount",
      title: `BA Chat · ${agent.name}`,
      transport,
    },
    stdout,
    terminal,
  });

  const receipt = transport.receipt;
  if (receipt) {
    stdout(
      `Agent:   ${agent.name} (${agent.id})\nSession: ${receipt.sessionId}\nUsage:   ${receipt.inputTokens} input + ${receipt.outputTokens} output tokens\nResume:  ba chat ${agent.id} --session ${receipt.sessionId}\n`
    );
  }
}
