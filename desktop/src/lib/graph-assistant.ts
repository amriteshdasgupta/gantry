import { z } from 'zod';
import { workflowSchema } from '../../../packages/shared/src/workflow';

export const graphAssistantRequestSchema = z.object({
  // Drafts may have disconnected nodes or missing references that the assistant
  // needs to repair. Keep field validation and limits, but defer graph-wide
  // invariants to the fully validated replacement in the response schema.
  graph: workflowSchema.innerType(),
  prompt: z.string().trim().min(1).max(10000),
  providerId: z.string().max(100).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(10000),
      }),
    )
    .max(12)
    .default([]),
});

export const graphAssistantResponseSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  graph: workflowSchema.refine((graph) => graph.edges !== undefined, 'Return a directed graph with edges.'),
});

export type GraphAssistantResponse = z.infer<typeof graphAssistantResponseSchema>;

/** Accept plain JSON or a single fenced JSON block, never partially salvage invalid graphs. */
export function parseGraphAssistantResponse(text: string): GraphAssistantResponse {
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');

  return graphAssistantResponseSchema.parse(JSON.parse(json));
}
