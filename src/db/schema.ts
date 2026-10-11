import { pgTable, text, bigint, timestamp, uuid, index, uniqueIndex, smallint } from 'drizzle-orm/pg-core'

// New uploads share one physical object while retaining independent logical IDs.
// Legacy rows intentionally have no objectId: their historical S3 keys and IDs
// must remain readable without trying to merge potentially inconsistent data.
export const blobObjects = pgTable('blob_objects', {
    id: uuid('id').primaryKey().defaultRandom(),
    hash: text('hash').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').$type<'pending' | 'active' | 'deleting'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
    unreferencedAt: timestamp('unreferenced_at', { withTimezone: false }),
}, (table) => ({
    hashSizeUnique: uniqueIndex('blob_objects_hash_size_unique').on(table.hash, table.size),
    storageKeyUnique: uniqueIndex('blob_objects_storage_key_unique').on(table.storageKey),
}))

export const blobs = pgTable('blobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    hash: text('hash').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: false }),
    deletedAt: timestamp('deleted_at', { withTimezone: false }),
    generation: smallint('generation').notNull().default(1),
    objectId: uuid('object_id').references(() => blobObjects.id, { onDelete: 'set null' }),
}, (table) => {
    return {
        hashSizeIdx: index('blobs_hash_size_idx').on(table.hash, table.size),
        objectIdIdx: index('blobs_object_id_idx').on(table.objectId),
    }
})
