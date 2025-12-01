import { pgTable, text, bigint, timestamp, uuid, index } from 'drizzle-orm/pg-core'

export const blobs = pgTable('blobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    hash: text('hash').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: false }),
    deletedAt: timestamp('deleted_at', { withTimezone: false }),
}, (table) => {
    return {
        hashSizeIdx: index('blobs_hash_size_idx').on(table.hash, table.size),
    }
})
