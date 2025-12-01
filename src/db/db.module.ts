import { Global, Module } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

export type BlobDb = ReturnType<typeof drizzle>;

@Global()
@Module({
    providers: [
        {
            provide: 'BLOB_DB',
            useFactory: () => {
                const connectionString = process.env.BLOB_PG_URL
                if (!connectionString) {
                    throw new Error('BLOB_PG_URL must be set')
                }
                const pool = new Pool({ connectionString })
                const db = drizzle(pool, { schema })
                return db
            },
        },
    ],
    exports: ['BLOB_DB'],
})
export class DbModule {}
