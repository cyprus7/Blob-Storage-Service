import { Injectable } from '@nestjs/common'
import { createHash } from 'crypto'
import { BlobStoragePort } from '../../domain/ports/blob-storage.port'
import { BlobRepository } from '../../domain/ports/blob.repository'
import { BlobInfo } from '../dto/blob-info.dto'
import { BlobEntity } from '../../domain/blob.entity'

@Injectable()
export class UploadBlobUseCase {
    constructor(
        private readonly storage: BlobStoragePort,
        private readonly repo: BlobRepository,
    ) { }

    async execute(file: Express.Multer.File): Promise<{ info: BlobInfo; deduplicated: boolean }> {
        const hash = createHash('sha256').update(file.buffer).digest('hex')
        const size = file.size
        const mime = file.mimetype || 'application/octet-stream'

        // The storage adapter builds a MIME-independent content key. Existing
        // legacy keys stay in their rows and are never rewritten.
        const storageKey = this.storage.buildKeyFromHash(hash, mime)
        const reservation = await this.repo.prepareUpload(hash, size, mime, storageKey)
        if (reservation.needsUpload) {
            // A pending DB row exists before the S3 write. If the final DB
            // transaction fails, another upload can retry the same key safely.
            await this.storage.putObject({
                key: reservation.object.storageKey,
                body: file.buffer,
                mime: reservation.object.mime,
            })
        }

        // Every call creates a fresh logical handle, even for identical bytes.
        const created = await this.repo.createLogicalBlob(hash, size, mime, reservation.needsUpload)

        return {
            deduplicated: !reservation.needsUpload,
            info: this.toDto(created),
        }
    }

    private toDto(entity: BlobEntity): BlobInfo {
        const p = entity.props
        return {
            id: p.id,
            hash: p.hash,
            size: p.size,
            mime: p.mime,
            storageKey: p.storageKey,
            createdAt: p.createdAt.toISOString(),
            lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
            deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
        }
    }
}
