CREATE TABLE "blob_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "generation" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "object_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "blob_objects_hash_size_unique" ON "blob_objects" USING btree ("hash","size");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_objects_storage_key_unique" ON "blob_objects" USING btree ("storage_key");--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_object_id_blob_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "blob_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blobs_object_id_idx" ON "blobs" USING btree ("object_id");
