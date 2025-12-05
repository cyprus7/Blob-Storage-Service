import { Global, Module, Logger } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { DefaultLogger, LogWriter } from 'drizzle-orm/logger'
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

                if (process.env.DB_LOG === 'true') {
                    const logger = new Logger('drizzle')

                    class NestWriter implements LogWriter {
                        write(message: string) {
                            // route Drizzle messages to Nest logger.debug
                            logger.debug(message)
                        }
                    }

                    return drizzle(pool, { schema, logger: new DefaultLogger({ writer: new NestWriter() }) })
                }

                return drizzle(pool, { schema })
            },
        },
    ],
    exports: ['BLOB_DB'],
})
export class DbModule { }
