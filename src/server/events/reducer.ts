import type { AgentEvent, EventType, SessionState } from '../../contracts/events';

const stateByEvent: Readonly<Record<EventType, SessionState['state']>> = {
  'session.started': 'IDLE',
  'turn.started': 'WORKING',
  'tool.started': 'WORKING',
  'tool.finished': 'WORKING',
  'approval.requested': 'WAITING_APPROVAL',
  'turn.stopped': 'STOPPED',
  'turn.interrupted': 'INTERRUPTED',
  'session.ended': 'ENDED',
};

const activeStates = new Set<SessionState['state']>(['WORKING', 'WAITING_APPROVAL']);
const terminalTurnEvents = new Set<EventType>(['turn.stopped', 'turn.interrupted']);
const lateWorkEvents = new Set<EventType>(['tool.started', 'tool.finished', 'approval.requested']);

function initialState(event: AgentEvent, receivedAt: string): SessionState {
  const confirmed = event.type === 'session.started' || (event.type === 'turn.started' && event.turnId !== null);
  return {
    state: stateByEvent[event.type],
    turnId: event.turnId,
    lastSequence: event.sequence,
    lastEventAt: event.occurredAt,
    lastReceivedAt: receivedAt,
    confidence: confirmed ? 'confirmed' : 'unconfirmed',
    currentTool: event.type === 'tool.started' ? event.metadata.toolName ?? null : null,
  };
}

function withEvent(previous: SessionState, event: AgentEvent, receivedAt: string, changes: Partial<SessionState> = {}): SessionState {
  return {
    ...previous,
    ...changes,
    lastSequence: event.sequence,
    lastEventAt: event.occurredAt,
    lastReceivedAt: receivedAt,
  };
}

export function reduceSession(previous: SessionState | null, event: AgentEvent, receivedAt: string): SessionState {
  if (previous && event.sequence <= previous.lastSequence) return previous;
  if (!previous) return initialState(event, receivedAt);

  if (event.type === 'turn.started') {
    return withEvent(previous, event, receivedAt, {
      state: 'WORKING',
      turnId: event.turnId,
      confidence: event.turnId ? 'confirmed' : 'unconfirmed',
      currentTool: null,
    });
  }

  // A delayed session start is bookkeeping; it must not erase a known active turn.
  if (event.type === 'session.started') {
    if (activeStates.has(previous.state)) return withEvent(previous, event, receivedAt);
    return withEvent(previous, event, receivedAt, {
      state: 'IDLE', turnId: null, confidence: previous.confidence, currentTool: null,
    });
  }

  // A delayed tool/approval hook must not resurrect a turn after a terminal event.
  if (lateWorkEvents.has(event.type) && ['STOPPED', 'INTERRUPTED', 'ENDED'].includes(previous.state)) {
    return withEvent(previous, event, receivedAt, { confidence: 'unconfirmed', currentTool: null });
  }

  if (event.type !== 'session.ended' && event.turnId !== null && previous.turnId !== null && event.turnId !== previous.turnId) {
    return withEvent(previous, event, receivedAt);
  }

  if (terminalTurnEvents.has(event.type) && event.turnId === null && previous.turnId !== null && activeStates.has(previous.state)) {
    return withEvent(previous, event, receivedAt, { confidence: 'unconfirmed' });
  }

  const mapped = stateByEvent[event.type];
  switch (event.type) {
    case 'tool.started':
      return withEvent(previous, event, receivedAt, {
        state: mapped,
        confidence: event.turnId === null ? 'unconfirmed' : previous.confidence,
        currentTool: event.metadata.toolName ?? null,
      });
    case 'tool.finished':
      return withEvent(previous, event, receivedAt, {
        state: mapped,
        confidence: event.turnId === null ? 'unconfirmed' : previous.confidence,
        currentTool: null,
      });
    case 'approval.requested':
      return withEvent(previous, event, receivedAt, {
        state: mapped,
        confidence: event.turnId === null ? 'unconfirmed' : previous.confidence,
        currentTool: null,
      });
    case 'turn.stopped':
    case 'turn.interrupted':
      return withEvent(previous, event, receivedAt, {
        state: mapped,
        turnId: event.turnId ?? previous.turnId,
        confidence: event.turnId === null ? 'unconfirmed' : previous.confidence,
        currentTool: null,
      });
    case 'session.ended':
      return withEvent(previous, event, receivedAt, { state: mapped, turnId: null, currentTool: null });
  }
}
