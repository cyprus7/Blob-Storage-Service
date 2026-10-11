import { Pool } from 'pg'

// PostgreSQL's two-integer advisory-lock keyspace is separate from the
// single-bigint keyspace used by per-hash upload/GC transactions.
export const GC_LOCK_CLASS_ID = 0x47430001
export const GC_LOCK_OBJECT_ID = 0x424c4f42

function requireReleased(released: boolean | undefined): void {
    if (released !== true) throw new Error('Blob GC advisory lock was lost')
}

/** Keep one dedicated pool client locked throughout a maintenance pass. */
export async function withExclusiveGcLock<T>(pool: Pool, operation: () => Promise<T>): Promise<T> {
    const client = await pool.connect()
    let acquired = false
    try {
        const result = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
            [GC_LOCK_CLASS_ID, GC_LOCK_OBJECT_ID],
        )
        acquired = result.rows[0]?.acquired === true
        if (!acquired) throw new Error('Another blob GC process is already running for this database')
        return await operation()
    } finally {
        try {
            if (acquired) {
                const unlocked = await client.query<{ released: boolean }>(
                    'SELECT pg_advisory_unlock($1::integer, $2::integer) AS released',
                    [GC_LOCK_CLASS_ID, GC_LOCK_OBJECT_ID],
                )
                requireReleased(unlocked.rows[0]?.released)
            }
        } finally {
            client.release()
        }
    }
}
