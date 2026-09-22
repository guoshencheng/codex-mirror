import type { EventType } from '../../src/contracts/events';
import type { EventWithoutIds } from './queue';

const eventMap: Readonly<Record<string, EventType>> = {
  SessionStart: 'session.started',
  UserPromptSubmit: 'turn.started',
  PreToolUse: 'tool.started',
  PostToolUse: 'tool.finished',
  PermissionRequest: 'approval.requested',
  Stop: 'turn.stopped',
  Interrupt: 'turn.interrupted',
  SessionEnd: 'session.ended',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export function normalizeHook(raw: unknown, now: () => Date = () => new Date()): EventWithoutIds | null {
  if (!isRecord(raw)) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).length > 1_000_000) return null;
  } catch { return null; }
  const type = typeof raw.hook_event_name === 'string' ? eventMap[raw.hook_event_name] : undefined;
  const sessionId = boundedText(raw.session_id, 128);
  if (!type || !sessionId) return null;
  const rawTurnId = raw.turn_id;
  if (typeof rawTurnId === 'string' && rawTurnId.length > 128) return null;
  const turnId = typeof rawTurnId === 'string' && rawTurnId.length > 0 ? rawTurnId : null;
  const toolName = boundedText(raw.tool_name, 120);
  if (['tool.started', 'tool.finished', 'approval.requested'].includes(type)
    && typeof raw.tool_name === 'string' && raw.tool_name.length > 120) return null;

  let occurredAt: string;
  try { occurredAt = now().toISOString(); }
  catch { return null; }

  return {
    schemaVersion: 1,
    sessionId,
    turnId: type === 'session.started' || type === 'session.ended' ? null : turnId,
    type,
    occurredAt,
    metadata: toolName && ['tool.started', 'tool.finished', 'approval.requested'].includes(type) ? { toolName } : {},
  };
}
