import { ConflictException, Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { blobObjects, blobs } from '../../../db/schema'
import type { BlobDb } from '../../../db/db.module'
import { BlobRepository, PhysicalBlob } from '../../../domain/ports/blob.repository'
import { BlobEntity, BlobProps } from '../../../domain/blob.entity'

@Injectable()
export class DrizzleBlobRepository extends BlobRepository {
    constructor(@Inject('BLOB_DB') private readonly db: BlobDb) {
        super()
    }

    async findById(id: string): Promise<BlobEntity | null> {
        const rows = await this.db.select().from(blobs).where(eq(blobs.id, id)).limit(1)
        return rows[0] ? this.mapRow(rows[0]) : null
    }

    async prepareUpload(hash: string, size: number, mime: string, storageKey: string): Promise<{ object: PhysicalBlob; needsUpload: boolean }> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.hash, hash), eq(blobObjects.size, size))).limit(1)
            if (rows[0]) {
                if (rows[0].status === 'deleting') {
                    throw new ConflictException('Blob object is being deleted; retry upload later')
                }
                return { object: this.mapObject(rows[0]), needsUpload: rows[0].status !== 'active' }
            }

            const inserted = await tx.insert(blobObjects).values({
                hash, size, mime, storageKey, status: 'pending',
            }).returning()
            return { object: this.mapObject(inserted[0]), needsUpload: true }
        })
    }

    async createLogicalBlob(hash: string, size: number, mime: string, uploaded: boolean): Promise<BlobEntity> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.hash, hash), eq(blobObjects.size, size))).limit(1)
            const object = rows[0]
            if (!object) throw new Error('Physical blob reservation is missing')
            if (object.status === 'deleting') {
                throw new ConflictException('Blob object is being deleted; retry upload later')
            }
            if (object.status !== 'active') {
                if (!uploaded) throw new Error('Physical blob is not active')
                // S3 PUT has completed before this transaction. A failed commit
                // leaves the pending reservation for a later retry.
                await tx.update(blobObjects).set({ status: 'active', updatedAt: new Date(), unreferencedAt: null })
                    .where(eq(blobObjects.id, object.id))
            } else if (object.unreferencedAt) {
                // A new active handle cancels any pending GC grace countdown.
                await tx.update(blobObjects).set({ unreferencedAt: null, updatedAt: new Date() })
                    .where(eq(blobObjects.id, object.id))
            }

            const inserted = await tx.insert(blobs).values({
                hash: object.hash,
                size: object.size,
                mime,
                storageKey: object.storageKey,
                generation: 2,
                objectId: object.id,
            }).returning()
            return this.mapRow(inserted[0])
        })
    }

    async touchActive(id: string): Promise<BlobEntity | null> {
        // A hot object is read much more often than it needs an access-time
        // write. This conditional UPDATE also cannot resurrect deletedAt.
        const updated = await this.db.update(blobs).set({ lastUsedAt: new Date() })
            .where(and(
                eq(blobs.id, id),
                isNull(blobs.deletedAt),
                or(isNull(blobs.lastUsedAt), lt(blobs.lastUsedAt, sql`now() - interval '5 minutes'`)),
            )).returning()
        if (updated[0]) return this.mapRow(updated[0])

        // The timestamp was fresh, or the handle was deleted. Preserve the
        // latter check instead of returning a stale entity from a prior read.
        const rows = await this.db.select().from(blobs)
            .where(and(eq(blobs.id, id), isNull(blobs.deletedAt))).limit(1)
        return rows[0] ? this.mapRow(rows[0]) : null
    }

    async softDeleteLogical(id: string): Promise<BlobEntity | null> {
        const existing = await this.findById(id)
        if (!existing || existing.generation !== 2) return null
        return this.withHashLock(existing.hash, async (tx) => {
            const updated = await tx.update(blobs)
                .set({ deletedAt: sql`coalesce(${blobs.deletedAt}, now())` })
                .where(and(eq(blobs.id, id), eq(blobs.generation, 2))).returning()
            if (!updated[0]) return null
            if (updated[0].objectId) await this.noteLastReferenceRemoved(tx, updated[0].objectId)
            return this.mapRow(updated[0])
        })
    }

    async hardDeleteLogical(id: string): Promise<BlobEntity | null> {
        // Only the logical handle is removed. S3 garbage collection requires
        // a separate reference audit and must never be done in this request.
        const existing = await this.findById(id)
        if (!existing || existing.generation !== 2) return null
        return this.withHashLock(existing.hash, async (tx) => {
            const removed = await tx.delete(blobs)
                .where(and(eq(blobs.id, id), eq(blobs.generation, 2))).returning()
            if (!removed[0]) return null
            if (removed[0].objectId) await this.noteLastReferenceRemoved(tx, removed[0].objectId)
            return this.mapRow(removed[0])
        })
    }

    async listStalePending(cutoff: Date, limit: number): Promise<PhysicalBlob[]> {
        const rows = await this.db.select().from(blobObjects)
            .where(and(eq(blobObjects.status, 'pending'), lte(blobObjects.updatedAt, cutoff)))
            .orderBy(asc(blobObjects.updatedAt)).limit(limit)
        return rows.map((row) => this.mapObject(row))
    }

    async recoverPending(id: string, hash: string): Promise<boolean> {
        return this.withHashLock(hash, async (tx) => {
            const updated = await tx.update(blobObjects)
                .set({ status: 'active', unreferencedAt: new Date(), updatedAt: new Date() })
                .where(and(eq(blobObjects.id, id), eq(blobObjects.hash, hash), eq(blobObjects.status, 'pending')))
                .returning({ id: blobObjects.id })
            return updated.length === 1
        })
    }

    async listUntrackedOrphans(limit: number): Promise<PhysicalBlob[]> {
        const rows = await this.db.select().from(blobObjects)
            .where(and(eq(blobObjects.status, 'active'), isNull(blobObjects.unreferencedAt), this.noBlockingReferences()))
            .orderBy(asc(blobObjects.createdAt)).limit(limit)
        return rows.map((row) => this.mapObject(row))
    }

    async markUnreferenced(id: string, hash: string): Promise<boolean> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.id, id), eq(blobObjects.hash, hash), eq(blobObjects.status, 'active'), isNull(blobObjects.unreferencedAt)))
                .limit(1)
            if (!rows[0] || !(await this.isSafeToRemove(tx, rows[0]))) return false
            const updated = await tx.update(blobObjects)
                .set({ unreferencedAt: new Date(), updatedAt: new Date() })
                .where(and(eq(blobObjects.id, id), eq(blobObjects.status, 'active'), isNull(blobObjects.unreferencedAt)))
                .returning({ id: blobObjects.id })
            return updated.length === 1
        })
    }

    async listEligibleForDeletion(cutoff: Date, limit: number): Promise<PhysicalBlob[]> {
        const rows = await this.db.select().from(blobObjects)
            .where(and(eq(blobObjects.status, 'active'), lte(blobObjects.unreferencedAt, cutoff), this.noBlockingReferences()))
            .orderBy(asc(blobObjects.unreferencedAt)).limit(limit)
        return rows.map((row) => this.mapObject(row))
    }

    async claimDeletion(id: string, hash: string, cutoff: Date): Promise<PhysicalBlob | null> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.id, id), eq(blobObjects.hash, hash), eq(blobObjects.status, 'active'), lte(blobObjects.unreferencedAt, cutoff)))
                .limit(1)
            if (!rows[0] || !(await this.isSafeToRemove(tx, rows[0]))) return null
            const updated = await tx.update(blobObjects)
                .set({ status: 'deleting', updatedAt: new Date() })
                .where(and(eq(blobObjects.id, id), eq(blobObjects.status, 'active'), lte(blobObjects.unreferencedAt, cutoff)))
                .returning()
            return updated[0] ? this.mapObject(updated[0]) : null
        })
    }

    async listDeleting(limit: number): Promise<PhysicalBlob[]> {
        const rows = await this.db.select().from(blobObjects)
            .where(eq(blobObjects.status, 'deleting'))
            .orderBy(asc(blobObjects.updatedAt)).limit(limit)
        return rows.map((row) => this.mapObject(row))
    }

    async getSafeDeleting(id: string, hash: string): Promise<PhysicalBlob | null> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.id, id), eq(blobObjects.hash, hash), eq(blobObjects.status, 'deleting'))).limit(1)
            return rows[0] && await this.isSafeToRemove(tx, rows[0]) ? this.mapObject(rows[0]) : null
        })
    }

    async finalizeDeletion(id: string, hash: string): Promise<boolean> {
        return this.withHashLock(hash, async (tx) => {
            const rows = await tx.select().from(blobObjects)
                .where(and(eq(blobObjects.id, id), eq(blobObjects.hash, hash), eq(blobObjects.status, 'deleting'))).limit(1)
            if (!rows[0] || !(await this.isSafeToRemove(tx, rows[0]))) return false
            const removed = await tx.delete(blobObjects)
                .where(and(eq(blobObjects.id, id), eq(blobObjects.status, 'deleting')))
                .returning({ id: blobObjects.id })
            return removed.length === 1
        })
    }

    private async noteLastReferenceRemoved(tx: BlobDb, objectId: string): Promise<void> {
        const active = await tx.select({ id: blobs.id }).from(blobs)
            .where(and(eq(blobs.objectId, objectId), isNull(blobs.deletedAt))).limit(1)
        if (active.length === 0) {
            await tx.update(blobObjects)
                .set({ unreferencedAt: sql`coalesce(${blobObjects.unreferencedAt}, now())`, updatedAt: new Date() })
                .where(and(eq(blobObjects.id, objectId), eq(blobObjects.status, 'active')))
        }
    }

    private noBlockingReferences() {
        return sql`not exists (
            select 1 from ${blobs} as r
            where (r.object_id = ${blobObjects.id} and r.deleted_at is null)
               or (r.storage_key = ${blobObjects.storageKey} and (r.deleted_at is null or r.generation = 1))
        )`
    }

    private async isSafeToRemove(tx: BlobDb, object: typeof blobObjects.$inferSelect): Promise<boolean> {
        const references = await tx.select({ id: blobs.id }).from(blobs)
            .where(or(
                and(eq(blobs.objectId, object.id), isNull(blobs.deletedAt)),
                and(eq(blobs.storageKey, object.storageKey), or(isNull(blobs.deletedAt), eq(blobs.generation, 1))),
            )).limit(1)
        return references.length === 0
    }

    private async withHashLock<T>(hash: string, operation: (tx: BlobDb) => Promise<T>): Promise<T> {
        return this.db.transaction(async (tx) => {
            // Transaction-scoped lock and all subsequent queries use this one
            // transaction connection. No second pool client is acquired while
            // holding the lock, including when pool max is 1.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`)
            return operation(tx as unknown as BlobDb)
        })
    }

    private mapObject(row: typeof blobObjects.$inferSelect): PhysicalBlob {
        return {
            id: row.id,
            hash: row.hash,
            size: row.size,
            mime: row.mime,
            storageKey: row.storageKey,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            unreferencedAt: row.unreferencedAt,
        }
    }

    private mapRow(row: unknown): BlobEntity {
        const r = row as Record<string, unknown>
        const createdRaw = r.createdAt
        const lastUsedRaw = r.lastUsedAt
        const deletedRaw = r.deletedAt

        const createdAt = typeof createdRaw === 'string' ? new Date(createdRaw) : (createdRaw as Date)
        const lastUsedAt = typeof lastUsedRaw === 'string' ? new Date(lastUsedRaw) : (lastUsedRaw as Date | null)
        const deletedAt = typeof deletedRaw === 'string' ? new Date(deletedRaw) : (deletedRaw as Date | null)

        const props: BlobProps = {
            id: String(r.id),
            hash: String(r.hash),
            size: Number(r.size),
            mime: String(r.mime),
            storageKey: String(r.storageKey),
            createdAt,
            lastUsedAt: lastUsedAt ?? null,
            deletedAt: deletedAt ?? null,
            generation: Number(r.generation ?? 1),
            objectId: r.objectId ? String(r.objectId) : null,
        }
        return new BlobEntity(props)
    }
}
