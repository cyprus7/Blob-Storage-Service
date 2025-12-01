import { Module } from '@nestjs/common'
import { BlobController } from './interface/http/blob.controller'
import { UploadBlobUseCase } from './application/use-cases/upload-blob.usecase'
import { GetBlobInfoUseCase } from './application/use-cases/get-blob-info.usecase'
import { GetBlobContentUseCase } from './application/use-cases/get-blob-content.usecase'
import { DeleteBlobUseCase } from './application/use-cases/delete-blob.usecase'
import { BlobStoragePort } from './domain/ports/blob-storage.port'
import { BlobRepository } from './domain/ports/blob.repository'
import { S3BlobStorageAdapter } from './infrastructure/storage/s3-blob-storage.adapter'
import { DrizzleBlobRepository } from './infrastructure/persistence/drizzle/blob.repository.drizzle'
import { ApiKeyGuard } from './interface/http/api-key.guard'

@Module({
    controllers: [BlobController],
    providers: [
        UploadBlobUseCase,
        GetBlobInfoUseCase,
        GetBlobContentUseCase,
        DeleteBlobUseCase,
        ApiKeyGuard,
        {
            provide: BlobStoragePort,
            useClass: S3BlobStorageAdapter,
        },
        {
            provide: BlobRepository,
            useClass: DrizzleBlobRepository,
        },
    ],
})
export class BlobModule {}
