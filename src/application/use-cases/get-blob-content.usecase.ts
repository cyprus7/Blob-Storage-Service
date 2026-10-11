import { Injectable, NotFoundException } from '@nestjs/common'
import { BlobRepository } from '../../domain/ports/blob.repository'
import { BlobStoragePort } from '../../domain/ports/blob-storage.port'
import { BlobInfo } from '../dto/blob-info.dto'
import { Readable } from 'stream'
import { BlobEntity } from '../../domain/blob.entity'

@Injectable()
export class GetBlobContentUseCase {
    constructor(
        private readonly repo: BlobRepository,
        private readonly storage: BlobStoragePort,
    ) {}

    async execute(id: string): Promise<{ info: BlobInfo; stream: Readable }> {
        const entity = await this.repo.findById(id)
        if (!entity || entity.isDeleted()) {
            throw new NotFoundException('Blob not found')
        }
        const stream = await this.storage.getObjectStream(entity.storageKey)
        let touched: BlobEntity | null
        try {
            // Only record access after S3 has successfully opened the stream.
            touched = await this.repo.touchActive(id)
        } catch (error) {
            stream.destroy()
            throw error
        }
        if (!touched) {
            stream.destroy()
            throw new NotFoundException('Blob not found')
        }

        return {
            info: this.toDto(touched),
            stream,
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
