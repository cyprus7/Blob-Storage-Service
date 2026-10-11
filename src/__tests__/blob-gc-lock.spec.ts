import { Pool } from 'pg'
import { withExclusiveGcLock } from '../maintenance/blob-gc-lock'

function fakePool() {
    let held = false
    const clients: Array<{ release: jest.Mock }> = []
    const pool = {
        connect: jest.fn().mockImplementation(async () => {
            const client = {
                query: jest.fn().mockImplementation(async (statement: string) => {
                    if (statement.includes('pg_try_advisory_lock')) {
                        const acquired = !held
                        if (acquired) held = true
                        return { rows: [{ acquired }] }
                    }
                    if (statement.includes('pg_advisory_unlock')) {
                        const released = held
                        held = false
                        return { rows: [{ released }] }
                    }
                    throw new Error('Unexpected SQL')
                }),
                release: jest.fn(),
            }
            clients.push(client)
            return client
        }),
    }
    return { pool: pool as unknown as Pool, clients }
}

describe('exclusive GC CLI lock', () => {
    it('fails a second concurrent process before it can touch objects', async () => {
        const h = fakePool()
        let entered!: () => void
        let finish!: () => void
        const firstEntered = new Promise<void>((resolve) => { entered = resolve })
        const holdFirst = new Promise<void>((resolve) => { finish = resolve })
        const first = withExclusiveGcLock(h.pool, async () => {
            entered()
            await holdFirst
            return 'first completed'
        })
        await firstEntered

        const secondOperation = jest.fn()
        await expect(withExclusiveGcLock(h.pool, secondOperation)).rejects.toThrow('already running')
        expect(secondOperation).not.toHaveBeenCalled()

        finish()
        await expect(first).resolves.toBe('first completed')
        await expect(withExclusiveGcLock(h.pool, async () => 'next pass')).resolves.toBe('next pass')
        expect(h.clients).toHaveLength(3)
        expect(h.clients.every((client) => client.release.mock.calls.length === 1)).toBe(true)
    })

    it('releases the session lock after a failed pass', async () => {
        const h = fakePool()
        await expect(withExclusiveGcLock(h.pool, async () => {
            throw new Error('S3 failed')
        })).rejects.toThrow('S3 failed')
        await expect(withExclusiveGcLock(h.pool, async () => 'retry')).resolves.toBe('retry')
        expect(h.clients).toHaveLength(2)
    })
})
