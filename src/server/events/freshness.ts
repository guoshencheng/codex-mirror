import type { SessionState } from '../../contracts/events';

export interface SessionFreshnessInput {
  state: SessionState;
  heartbeatAt: string | null;
  now: string;
  streamIncomplete: boolean;
}

export function deriveFreshness(input: SessionFreshnessInput): {
  connection: 'online' | 'stale' | 'offline';
  confidence: 'confirmed' | 'unconfirmed';
} {
  const now = Date.parse(input.now);
  const heartbeat = input.heartbeatAt === null ? Number.NaN : Date.parse(input.heartbeatAt);
  const heartbeatAgeSeconds = Number.isFinite(heartbeat) && Number.isFinite(now)
    ? Math.max(0, (now - heartbeat) / 1000)
    : Number.POSITIVE_INFINITY;
  const connection = heartbeatAgeSeconds >= 120 ? 'offline' : heartbeatAgeSeconds >= 60 ? 'stale' : 'online';

  const lastReceived = Date.parse(input.state.lastReceivedAt);
  const eventAgeSeconds = Number.isFinite(lastReceived) && Number.isFinite(now)
    ? Math.max(0, (now - lastReceived) / 1000)
    : Number.POSITIVE_INFINITY;
  const executionSilent = (input.state.state === 'WORKING' || input.state.state === 'WAITING_APPROVAL') && eventAgeSeconds >= 600;
  const confidence = input.streamIncomplete || executionSilent ? 'unconfirmed' : input.state.confidence;
  return { connection, confidence };
}
