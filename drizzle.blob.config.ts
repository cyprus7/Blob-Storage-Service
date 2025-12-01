import { defineConfig } from 'drizzle-kit'

function buildDbUrl(): string {
    const url = process.env.BLOB_PG_URL
    if (url && url.trim()) return url.trim()

    const host = process.env.BLOB_PGHOST
    const database = process.env.BLOB_PGDATABASE
    const user = process.env.BLOB_PGUSER
    const password = process.env.BLOB_PGPASSWORD ?? ''
    const port = process.env.BLOB_PGPORT

    if (!host || !database || !user) {
        throw new Error(
            'Blob DB connection is not configured. Set BLOB_PG_URL or BLOB_PGHOST/BLOB_PGDATABASE/BLOB_PGUSER (and optionally BLOB_PGPASSWORD/BLOB_PGPORT).'
        )
    }

    const portPart = port ? `:${port}` : ''
    const auth = user + (password ? `:${encodeURIComponent(password)}` : '')
    return `postgresql://${auth}@${host}${portPart}/${database}`
}

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './migrations/blob-service',
    dialect: 'postgresql',
    dbCredentials: {
        url: buildDbUrl(),
    },
})
