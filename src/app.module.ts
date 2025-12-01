import { Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { BlobModule } from './blob.module'
import { HealthController } from './health/health.controller'

@Module({
    imports: [DbModule, BlobModule],
    controllers: [HealthController],
})
export class AppModule { }
