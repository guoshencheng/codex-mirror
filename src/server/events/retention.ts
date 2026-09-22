import type { Pool } from 'pg';

const retentionLock = 'codex-status-dashboard:agent-events-retention';

/** Removes expired, applied hook history without deleting event-gap evidence or live state. */
export async function cleanupAgentEvents(pool: Pool, before: Date): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [retentionLock]);
    const result = await client.query(`
      DELETE FROM agent_events AS event
      WHERE event.received_at < $1
        AND event.applied = true
        AND NOT (
          event.event_type = 'turn.started'
          AND event.payload->>'turnId' IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sessions AS session
            WHERE session.device_id = event.device_id
              AND session.session_id = event.session_id
              AND session.state->>'turnId' = event.payload->>'turnId'
          )
        )
    `, [before]);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
