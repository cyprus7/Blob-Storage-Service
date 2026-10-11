import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema'
import { DrizzleBlobRepository } from '../infrastructure/persistence/drizzle/blob.repository.drizzle'
import { S3BlobStorageAdapter } from '../infrastructure/storage/s3-blob-storage.adapter'
import { BlobGcService } from './blob-gc.service'
import { withExclusiveGcLock } from './blob-gc-lock'

const usage = `Usage: node dist/maintenance/blob-gc.js [--execute] [--grace-hours=24] [--limit=100]

Dry run is the default. --execute enables DB transitions and S3 deletion.
Requires migrations 0000, 0001, and 0002, BLOB_PG_URL, and S3 credentials.
Grace period cannot be less than 24 hours.\n`

function parseArgs(args: string[]): { execute: boolean; graceHours: number; limit: number; help: boolean } {
    const parsed = { execute: false, graceHours: 24, limit: 100, help: false }
    for (const arg of args) {
        if (arg === '--help' || arg === '-h') parsed.help = true
        else if (arg === '--execute') parsed.execute = true
        else if (arg.startsWith('--grace-hours=')) parsed.graceHours = Number(arg.slice('--grace-hours='.length))
        else if (arg.startsWith('--limit=')) parsed.limit = Number(arg.slice('--limit='.length))
        else throw new Error(`Unknown argument: ${arg}`)
    }
    return parsed
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        process.stdout.write(usage)
        return
    }
    if (!process.env.BLOB_PG_URL) throw new Error('BLOB_PG_URL must be set')

    // One client is reserved for the session lock, while repository
    // transactions use other clients. This cannot deadlock a size-one pool.
    const pool = new Pool({ connectionString: process.env.BLOB_PG_URL, max: 4 })
    try {
        await withExclusiveGcLock(pool, async () => {
            const db = drizzle(pool, { schema })
            const repository = new DrizzleBlobRepository(db)
            const storage = new S3BlobStorageAdapter()
            const summary = await new BlobGcService(repository, storage).run(options)
            process.stdout.write(`${JSON.stringify(summary)}\n`)
            if (summary.errors.length > 0) process.exitCode = 1
        })
    } finally {
        await pool.end()
    }
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
})
