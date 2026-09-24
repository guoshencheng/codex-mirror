import { describe, expect, it } from 'vitest';
import type { AgentEvent, EventType, SessionState } from '../../src/contracts/events';
import { deriveFreshness } from '../../src/server/events/freshness';
import { reduceSession } from '../../src/server/events/reducer';

const at = '2026-09-22T00:00:00Z';
const received = '2026-09-22T00:00:01Z';
const event = (sequence: number, type: EventType, turnId: string | null = 't1', metadata: AgentEvent['metadata'] = {}): AgentEvent => ({
  schemaVersion: 1, eventId: `e${sequence}`, deviceId: 'd1', collectorEpoch: 'epoch1',
  sequence, sessionId: 's1', turnId, type, occurredAt: at, metadata,
});

describe('session state reducer', () => {
  it('applies title metadata without changing execution state or activity time', () => {
    const working = reduceSession(null, event(1, 'turn.started'), received);
    const metadata = reduceSession(working, event(2, 'session.metadata.updated', null, { title: 'New title' }), '2026-09-22T00:05:00Z');
    expect(metadata).toMatchObject({ state: 'WORKING', lastSequence: 2, lastEventAt: at, lastReceivedAt: received });
  });

  it('resumes work after approval without exposing a tool name', () => {
    const started = reduceSession(null, event(1, 'turn.started'), received);
    const waiting = reduceSession(started, event(2, 'approval.requested'), received);
    const resumed = reduceSession(waiting, event(3, 'turn.resumed'), received);
    expect(resumed).toMatchObject({ state: 'WORKING', currentTool: null });
  });

  it('does not let a delayed old-turn Stop end the current turn', () => {
    const first = reduceSession(null, event(1, 'turn.started'), received);
    const next = reduceSession(first, event(2, 'turn.started', 't2'), received);
    const late = reduceSession(next, event(3, 'turn.stopped', 't1'), received);
    expect(late.state).toBe('WORKING');
    expect(late.turnId).toBe('t2');
    expect(late.lastSequence).toBe(3);
  });

  it('does not reopen a stopped turn when a later-arriving tool hook belongs to it', () => {
    const started = reduceSession(null, event(1, 'turn.started', 't1'), received);
    const stopped = reduceSession(started, event(2, 'turn.stopped', 't1'), received);
    const delayedTool = reduceSession(stopped, event(3, 'tool.started', 't1', { toolName: 'terminal' }), received);
    expect(delayedTool.state).toBe('STOPPED');
    expect(delayedTool.currentTool).toBeNull();
    expect(delayedTool.confidence).toBe('unconfirmed');
  });

  it('maps lifecycle events without calling Stop success', () => {
    let state: SessionState | null = null;
    const cases: Array<[EventType, SessionState['state']]> = [
      ['session.started', 'IDLE'], ['turn.started', 'WORKING'], ['tool.started', 'WORKING'],
      ['tool.finished', 'WORKING'], ['approval.requested', 'WAITING_APPROVAL'],
      ['turn.stopped', 'STOPPED'], ['turn.interrupted', 'INTERRUPTED'], ['session.ended', 'ENDED'],
    ];
    cases.forEach(([type, expected], index) => {
      state = reduceSession(state, event(index + 1, type), received);
      expect(state.state).toBe(expected);
    });
  });

  it('ignores stale turn tools and keeps only current-turn tool state', () => {
    const running = reduceSession(null, event(1, 'turn.started'), received);
    const tool = reduceSession(running, event(2, 'tool.started', 't1', { toolName: 'terminal' }), received);
    expect(tool.currentTool).toBe('terminal');
    const switched = reduceSession(tool, event(3, 'turn.started', 't2'), received);
    const oldTool = reduceSession(switched, event(4, 'tool.started', 't1', { toolName: 'secret-tool' }), received);
    expect(oldTool).toMatchObject({ state: 'WORKING', turnId: 't2', currentTool: null, lastSequence: 4 });
    const finished = reduceSession(oldTool, event(5, 'tool.finished', 't2'), received);
    expect(finished.currentTool).toBeNull();
    expect(finished.state).toBe('WORKING');
  });

  it('marks an unassociated terminal event uncertain without ending the active turn', () => {
    const running = reduceSession(null, event(1, 'turn.started'), received);
    const late = reduceSession(running, event(2, 'turn.interrupted', null), received);
    expect(late).toMatchObject({ state: 'WORKING', turnId: 't1', confidence: 'unconfirmed' });
  });

  it('does not reset work when a session-start notification arrives late', () => {
    const running = reduceSession(null, event(1, 'turn.started'), received);
    expect(reduceSession(running, event(2, 'session.started', null), received))
      .toMatchObject({ state: 'WORKING', turnId: 't1' });
  });

  it('starts unconfirmed on an orphan tool event and confirms on explicit turn.started', () => {
    const orphan = reduceSession(null, event(1, 'tool.started', 't1', { toolName: 'edit' }), received);
    expect(orphan).toMatchObject({ state: 'WORKING', confidence: 'unconfirmed', currentTool: 'edit' });
    expect(reduceSession(orphan, event(2, 'turn.started', 't1'), received).confidence).toBe('confirmed');
  });

  it('does not move backward for duplicate or older sequence numbers', () => {
    const running = reduceSession(null, event(3, 'turn.started'), received);
    expect(reduceSession(running, event(2, 'turn.stopped'), received)).toBe(running);
  });
});

describe('device and execution freshness', () => {
  const state = reduceSession(null, event(1, 'turn.started'), at);
  it.each([
    [59, 'online'], [60, 'stale'], [119, 'stale'], [120, 'offline'],
  ] as const)('uses heartbeat age %i seconds for connection status', (ageSeconds, connection) => {
    const now = new Date('2026-09-22T00:02:00Z');
    const heartbeatAt = new Date(now.getTime() - ageSeconds * 1000).toISOString();
    expect(deriveFreshness({ state, heartbeatAt, now: now.toISOString(), streamIncomplete: false }).connection).toBe(connection);
  });

  it('does not let a heartbeat confirm an event-silent execution', () => {
    expect(deriveFreshness({ state, now: '2026-09-22T00:11:00Z', heartbeatAt: '2026-09-22T00:11:00Z', streamIncomplete: false }))
      .toEqual({ connection: 'online', confidence: 'unconfirmed' });
  });

  it('marks an incomplete stream uncertain and treats missing heartbeat as offline', () => {
    expect(deriveFreshness({ state, now: '2026-09-22T00:00:02Z', heartbeatAt: null, streamIncomplete: true }))
      .toEqual({ connection: 'offline', confidence: 'unconfirmed' });
  });

  it('uses server receive time so a future device clock cannot keep work confirmed', () => {
    const future = { ...event(1, 'turn.started'), occurredAt: '2099-01-01T00:00:00Z' };
    const futureState = reduceSession(null, future, at);
    expect(deriveFreshness({ state: futureState, now: '2026-09-22T00:11:00Z', heartbeatAt: at, streamIncomplete: false }).confidence)
      .toBe('unconfirmed');
  });
});
