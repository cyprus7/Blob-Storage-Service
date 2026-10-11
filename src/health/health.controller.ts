import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { BlobDb } from '../db/db.module'
import { BlobStoragePort } from '../domain/ports/blob-storage.port'

@Controller()
export class HealthController {
    constructor(
        @Inject('BLOB_DB') private readonly db: BlobDb,
        private readonly storage: BlobStoragePort,
    ) {}

    @Get('/health')
    health() {
        return { status: 'ok' }
    }

    @Get('/ready')
    async ready() {
        try {
            await Promise.all([
                this.db.execute(sql`SELECT 1`),
                this.storage.checkReady(),
            ])
            return { status: 'ok' }
        } catch {
            throw new ServiceUnavailableException('Blob dependencies unavailable')
        }
    }
}
