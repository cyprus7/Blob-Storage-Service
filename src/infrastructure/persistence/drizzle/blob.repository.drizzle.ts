import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { blobs } from '../../../db/schema'
import type { BlobDb } from '../../../db/db.module'
import { BlobRepository } from '../../../domain/ports/blob.repository'
import { BlobEntity, BlobProps } from '../../../domain/blob.entity'

@Injectable()
export class DrizzleBlobRepository extends BlobRepository {
    constructor(
        @Inject('BLOB_DB') private readonly db: BlobDb,
    ) {
        super()
    }

    async findById(id: string): Promise<BlobEntity | null> {
        const rows = await this.db.select().from(blobs).where(eq(blobs.id, id))
        if (!rows[0]) return null
        return this.mapRow(rows[0])
    }

    async findByHashAndSize(hash: string, size: number): Promise<BlobEntity | null> {
        const rows = await this.db
            .select()
            .from(blobs)
            .where(and(eq(blobs.hash, hash), eq(blobs.size, size)))

        if (!rows[0]) return null
        return this.mapRow(rows[0])
    }

    async save(props: Omit<BlobProps, 'id' | 'createdAt' | 'lastUsedAt' | 'deletedAt'>): Promise<BlobEntity> {
        const inserted = await this.db
            .insert(blobs)
            .values({
                hash: props.hash,
                size: props.size,
                mime: props.mime,
                storageKey: props.storageKey,
            })
            .returning()

        return this.mapRow(inserted[0])
    }

    async update(entity: BlobEntity): Promise<BlobEntity> {
        const p = entity.props
        const updated = await this.db
            .update(blobs)
            .set({
                hash: p.hash,
                size: p.size,
                mime: p.mime,
                storageKey: p.storageKey,
                lastUsedAt: p.lastUsedAt,
                deletedAt: p.deletedAt,
            })
            .where(eq(blobs.id, p.id))
            .returning()

        return this.mapRow(updated[0])
    }

    async delete(id: string): Promise<void> {
        await this.db.delete(blobs).where(eq(blobs.id, id))
    }

    private mapRow(row: unknown): BlobEntity {
        const r = row as Record<string, unknown>
        const createdRaw = r.createdAt
        const lastUsedRaw = r.lastUsedAt
        const deletedRaw = r.deletedAt

        const createdAt =
            typeof createdRaw === 'string' ? new Date(createdRaw) : (createdRaw as Date)
        const lastUsedAt =
            typeof lastUsedRaw === 'string' ? new Date(lastUsedRaw) : (lastUsedRaw as Date | null)
        const deletedAt =
            typeof deletedRaw === 'string' ? new Date(deletedRaw) : (deletedRaw as Date | null)

        const props: BlobProps = {
            id: String(r.id),
            hash: String(r.hash),
            size: Number(r.size),
            mime: String(r.mime),
            storageKey: String(r.storageKey),
            createdAt,
            lastUsedAt: lastUsedAt ?? null,
            deletedAt: deletedAt ?? null,
        }

        return new BlobEntity(props)
    }
}
