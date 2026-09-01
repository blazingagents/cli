import { agentIdSchema } from "@blazingagents/sdk/contracts";

interface SelectableAgent {
  id: string;
  name: string;
}

export class AgentSelectionError extends Error {
  override name = "AgentSelectionError";
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

  const exactNameMatch = agents.find((agent) => agent.name === selector);
  if (exactNameMatch) {
    return exactNameMatch;
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
