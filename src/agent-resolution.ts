import type { Agent, BlazingAgents } from "@blazingagents/sdk";
import { agentIdSchema } from "@blazingagents/sdk/contracts";

interface SelectableAgent {
  id: string;
  name: string;
}

export class AgentSelectionError extends Error {
  override name = "AgentSelectionError";
}

export async function listAgents(
  client: BlazingAgents,
  abortSignal?: AbortSignal
): Promise<Agent[]> {
  const agents: Agent[] = [];
  let cursor: string | undefined;
  do {
    abortSignal?.throwIfAborted();
    const page = await client.agents.list({ cursor, abortSignal });
    abortSignal?.throwIfAborted();
    agents.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return agents;
}

export function resolveAgent<Agent extends SelectableAgent>(
  selector: string,
  agents: readonly Agent[]
): Agent {
  if (agentIdSchema.safeParse(selector).success) {
    const exactIdMatch = agents.find((agent) => agent.id === selector);
    if (exactIdMatch) {
      return exactIdMatch;
    }
    throw new AgentSelectionError(`No Agent found with id ${selector}.`);
  }

  const exactNameMatches = agents.filter((agent) => agent.name === selector);
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0];
  }
  if (exactNameMatches.length > 1) {
    throw new AgentSelectionError(
      `Agent name "${selector}" is ambiguous. Use an Agent id.\n${exactNameMatches.map((agent) => `- ${agent.name} (${agent.id})`).join("\n")}`
    );
  }

  const normalizedSelector = selector.toLowerCase();
  const caseInsensitiveMatches = agents.filter(
    (agent) => agent.name.toLowerCase() === normalizedSelector
  );
  const [caseInsensitiveMatch] = caseInsensitiveMatches;
  if (!caseInsensitiveMatch) {
    throw new AgentSelectionError(`No Agent found with name ${selector}.`);
  }
  if (caseInsensitiveMatches.length > 1) {
    const candidates = caseInsensitiveMatches
      .map((agent) => `- ${agent.name} (${agent.id})`)
      .join("\n");
    throw new AgentSelectionError(
      `Agent name "${selector}" is ambiguous. Use an exact name or id:\n${candidates}`
    );
  }

  return caseInsensitiveMatch;
}
