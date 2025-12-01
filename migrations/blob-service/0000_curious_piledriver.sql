CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"deleted_at" timestamp
);

CREATE INDEX "blobs_hash_size_idx" ON "blobs" USING btree ("hash","size");

CREATE INDEX "blobs_storage_key_idx" ON "blobs" USING btree ("storage_key");
