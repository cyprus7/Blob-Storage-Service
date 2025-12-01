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

        const existing = await this.repo.findByHashAndSize(hash, size)
        if (existing && !existing.isDeleted()) {
            existing.markUsed()
            const updated = await this.repo.update(existing)
            return {
                deduplicated: true,
                info: this.toDto(updated),
            }
        }

        const storageKey = this.storage.buildKeyFromHash(hash, mime)

        await this.storage.putObject({
            key: storageKey,
            body: file.buffer,
            mime,
        })

        const created = await this.repo.save({
            hash,
            size,
            mime,
            storageKey,
        })

        return {
            deduplicated: false,
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
