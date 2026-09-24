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
  const toolName = boundedText(raw.tool_name, 120)?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || undefined;
  let occurredAt: string;
  try { occurredAt = now().toISOString(); }
  catch { return null; }

  return {
    schemaVersion: 1,
    sessionId,
    harness: 'codex',
    ...(raw.client_type === 'codex_cli' ? { clientType: 'cli' as const }
      : raw.client_type === 'codex_desktop' || raw.client_type === 'codex_app' ? { clientType: 'desktop' as const } : {}),
    turnId: type === 'session.started' || type === 'session.ended' ? null : turnId,
    type,
    occurredAt,
    metadata: toolName && ['tool.started', 'approval.requested'].includes(type) ? { toolName } : {},
  };
}

/** Keep Kimi session IDs separate from Codex IDs in the shared device queue. */
export function normalizeKimiHook(raw: unknown, now: () => Date = () => new Date()): EventWithoutIds | null {
  if (!isRecord(raw)) return null;
  const kimiEvents: Readonly<Record<string, string>> = {
    SessionStart: 'SessionStart', TurnStarted: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse',
    PermissionRequest: 'PermissionRequest', Stop: 'Stop',
    Interrupt: 'Interrupt', SessionEnd: 'SessionEnd',
  };
  const name = typeof raw.hook_event_name === 'string' ? kimiEvents[raw.hook_event_name] : undefined;
  const sessionId = boundedText(raw.session_id, 123);
  if (!name || !sessionId) return null;
  const normalized = normalizeHook({ ...raw, hook_event_name: name, session_id: `kimi:${sessionId}` }, now);
  if (!normalized) return null;
  const title = boundedText(raw.session_title, 160)?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const clientType = raw.client_type === 'kimi_code_cli' ? 'cli'
    : raw.client_type === 'kimi_code_desktop' || raw.client_type === 'kimi_code_app' ? 'desktop' : undefined;
  return {
    ...normalized,
    harness: 'kimi',
    ...(clientType ? { clientType } : {}),
    metadata: title ? { ...normalized.metadata, title } : normalized.metadata,
  };
}
