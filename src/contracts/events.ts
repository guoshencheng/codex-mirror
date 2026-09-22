import { z } from 'zod';

export const eventTypes = [
  'session.started', 'turn.started', 'tool.started', 'tool.finished',
  'approval.requested', 'turn.stopped', 'turn.interrupted', 'session.ended',
] as const;

export type EventType = typeof eventTypes[number];

const metadataSchema = z.object({
  projectKey: z.string().min(1).max(160).optional(),
  projectName: z.string().min(1).max(160).optional(),
  title: z.string().min(1).max(160).optional(),
  toolName: z.string().min(1).max(120).optional(),
}).strict();

export const agentEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  collectorEpoch: z.string().min(1).max(128),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sessionId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128).nullable(),
  type: z.enum(eventTypes),
  occurredAt: z.string().datetime({ offset: true }),
  metadata: metadataSchema,
}).strict().superRefine((event, context) => {
  if (new TextEncoder().encode(JSON.stringify(event)).length > 8_192) {
    context.addIssue({ code: 'custom', message: 'Event exceeds 8 KiB', path: [] });
  }
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

export interface SessionState {
  state: 'IDLE' | 'WORKING' | 'WAITING_APPROVAL' | 'STOPPED' | 'INTERRUPTED' | 'ENDED' | 'UNKNOWN';
  turnId: string | null;
  lastSequence: number;
  lastEventAt: string;
  lastReceivedAt: string;
  confidence: 'confirmed' | 'unconfirmed';
  currentTool: string | null;
}
