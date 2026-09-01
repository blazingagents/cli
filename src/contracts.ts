import {
  agentIdSchema as sdkAgentIdSchema,
  type toolApprovalDecisionResponseSchema,
  type toolApprovalsResponseSchema,
  type usageSummarySchema,
} from "@blazingagents/sdk/contracts";
import { z } from "zod";

export const apiKeyTokenSchema = z.string().regex(/^ba_[0-9A-Za-z]{40}$/);
export const metadataSchema = z.record(z.string(), z.unknown());
export const promptIdSchema = z.string().regex(/^prompt_[0-9A-Za-z]{16}$/);

export const isAdminAgentId = (id: string): boolean =>
  id.startsWith("ag_adm") && sdkAgentIdSchema.safeParse(id).success;

export const jsonSchemaShapeSchema = z.custom<z.core.JSONSchema.JSONSchema>(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const schema = value as Record<string, unknown>;
    if (!("type" in schema || "properties" in schema)) {
      return false;
    }
    try {
      z.fromJSONSchema(value as z.core.JSONSchema.JSONSchema);
      return true;
    } catch {
      return false;
    }
  }
);

export type PromptVariables = Record<string, string>;
export type ToolApprovalDecisionResponse = z.infer<
  typeof toolApprovalDecisionResponseSchema
>;
export type ToolApprovalsResponse = z.infer<typeof toolApprovalsResponseSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
