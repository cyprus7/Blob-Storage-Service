import { Injectable, NotFoundException } from '@nestjs/common'
import { BlobRepository } from '../../domain/ports/blob.repository'
import { BlobInfo } from '../dto/blob-info.dto'
import { BlobEntity } from '../../domain/blob.entity'

@Injectable()
export class GetBlobInfoUseCase {
    constructor(private readonly repo: BlobRepository) {}

    async execute(id: string): Promise<BlobInfo> {
        const entity = await this.repo.findById(id)
        if (!entity || entity.isDeleted()) {
            throw new NotFoundException('Blob not found')
        }

        entity.markUsed()
        const updated = await this.repo.update(entity)

        return this.toDto(updated)
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
