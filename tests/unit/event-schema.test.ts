import { describe, expect, it } from 'vitest';
import { agentEventSchema } from '../../src/contracts/events';

const valid = {
  schemaVersion: 1, eventId: 'event-1', deviceId: 'device-1', collectorEpoch: 'epoch-1',
  sequence: 1, sessionId: 'session-1', turnId: 'turn-1', type: 'turn.started',
  occurredAt: '2026-09-22T00:00:00Z', metadata: { projectName: 'Project', title: 'Task' },
};

describe('agent event contract', () => {
  it('accepts a versioned, bounded lifecycle event', () => {
    expect(agentEventSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown fields at the event and metadata levels', () => {
    expect(agentEventSchema.safeParse({ ...valid, prompt: 'must not leave device' }).success).toBe(false);
    expect(agentEventSchema.safeParse({ ...valid, metadata: { ...valid.metadata, command: 'private' } }).success).toBe(false);
  });

  it.each([
    ['sequence zero', { ...valid, sequence: 0 }],
    ['unsafe sequence', { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['bad version', { ...valid, schemaVersion: 2 }],
    ['invalid event name', { ...valid, type: 'tool.failed' }],
    ['missing timezone', { ...valid, occurredAt: '2026-09-22T00:00:00' }],
    ['oversized title', { ...valid, metadata: { title: 'x'.repeat(161) } }],
    ['oversized tool name', { ...valid, metadata: { toolName: 'x'.repeat(121) } }],
    ['oversized event body', { ...valid, metadata: { title: 'x'.repeat(8193) } }],
  ])('rejects %s', (_name, candidate) => {
    expect(agentEventSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts a null turn id and bounds identifiers', () => {
    expect(agentEventSchema.safeParse({ ...valid, turnId: null }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...valid, deviceId: 'd'.repeat(129) }).success).toBe(false);
  });
});
