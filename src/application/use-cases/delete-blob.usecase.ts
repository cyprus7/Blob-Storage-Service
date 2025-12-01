import { Injectable, NotFoundException } from '@nestjs/common'
import { BlobRepository } from '../../domain/ports/blob.repository'
import { BlobStoragePort } from '../../domain/ports/blob-storage.port'
import { BlobInfo } from '../dto/blob-info.dto'
import { BlobEntity } from '../../domain/blob.entity'

@Injectable()
export class DeleteBlobUseCase {
    constructor(
        private readonly repo: BlobRepository,
        private readonly storage: BlobStoragePort,
    ) {}

    async execute(id: string, force: boolean): Promise<BlobInfo> {
        const entity = await this.repo.findById(id)
        if (!entity) {
            throw new NotFoundException('Blob not found')
        }

        if (force) {
            // Hard delete: delete from storage & DB
            await this.storage.deleteObject(entity.storageKey)
            await this.repo.delete(entity.id)
            return this.toDto(entity)
        }

        if (!entity.isDeleted()) {
            entity.softDelete()
            const updated = await this.repo.update(entity)
            return this.toDto(updated)
        }

        // Already soft-deleted
        return this.toDto(entity)
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
