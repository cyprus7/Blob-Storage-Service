import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { BlobRepository } from '../../domain/ports/blob.repository'
import { BlobInfo } from '../dto/blob-info.dto'
import { BlobEntity } from '../../domain/blob.entity'

@Injectable()
export class DeleteBlobUseCase {
    constructor(
        private readonly repo: BlobRepository,
    ) {}

    async execute(id: string, force: boolean): Promise<BlobInfo> {
        const entity = await this.repo.findById(id)
        if (!entity) {
            throw new NotFoundException('Blob not found')
        }

        // A legacy ID may be stored by an unknown number of external records.
        // Neither soft nor hard delete can be safe until those references are
        // migrated to independent handles.
        if (entity.generation !== 2) {
            throw new ConflictException('Legacy blob references cannot be deleted')
        }

        if (force) {
            // Physical S3 data is retained. A separate, audited garbage
            // collector may remove unreferenced objects in the future.
            const removed = await this.repo.hardDeleteLogical(id)
            if (!removed) throw new NotFoundException('Blob not found')
            return this.toDto(removed)
        }

        const updated = await this.repo.softDeleteLogical(id)
        if (!updated) throw new NotFoundException('Blob not found')
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
