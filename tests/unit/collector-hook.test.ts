import { describe, expect, it } from 'vitest';
import { normalizeHook } from '../../collector/src/hook';

describe('Codex hook normalization', () => {
  it('maps supported lifecycle hooks and discards prompt, tool input, output, and paths', () => {
    const hook = normalizeHook({
      hook_event_name: 'PostToolUse', session_id: 'codex-session', turn_id: 'turn-1', cwd: '/Users/alice/private/project',
      tool_name: 'Bash', tool_input: { command: 'SECRET_COMMAND' }, transcript_path: '/private/transcript.jsonl',
      prompt: 'SECRET_PROMPT', tool_output: 'SECRET_OUTPUT',
    }, () => new Date('2026-09-22T00:00:00Z'));
    expect(hook).toEqual({
      schemaVersion: 1, sessionId: 'codex-session', turnId: 'turn-1', type: 'tool.finished',
      occurredAt: '2026-09-22T00:00:00.000Z', metadata: {},
    });
    expect(JSON.stringify(hook)).not.toMatch(/SECRET_|private|alice/);
  });

  it.each([
    ['SessionStart', 'session.started'], ['UserPromptSubmit', 'turn.started'],
    ['PreToolUse', 'tool.started'], ['PostToolUse', 'tool.finished'],
    ['PermissionRequest', 'approval.requested'], ['Stop', 'turn.stopped'],
    ['Interrupt', 'turn.interrupted'], ['SessionEnd', 'session.ended'],
  ] as const)('maps %s to %s', (hook_event_name, type) => {
    const normalized = normalizeHook({ hook_event_name, session_id: 's', turn_id: 't', tool_name: 'Edit' });
    expect(normalized?.type).toBe(type);
  });

  it('ignores unsupported, malformed, and oversized hook payloads', () => {
    expect(normalizeHook({ hook_event_name: 'PreCompact', session_id: 's' })).toBeNull();
    expect(normalizeHook({ hook_event_name: 'Stop', session_id: '' })).toBeNull();
    expect(normalizeHook({ hook_event_name: 'Stop', session_id: 's'.repeat(129) })).toBeNull();
  });

  it('does not infer completion from a tool failure field', () => {
    const normalized = normalizeHook({
      hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', tool_name: 'Bash',
      tool_output: { error: 'SECRET_ERROR' },
    });
    expect(normalized).toMatchObject({ type: 'tool.finished', metadata: {} });
    expect(JSON.stringify(normalized)).not.toContain('SECRET_ERROR');
  });
});
