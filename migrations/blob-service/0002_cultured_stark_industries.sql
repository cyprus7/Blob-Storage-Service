ALTER TABLE "blobs" DROP CONSTRAINT "blobs_object_id_blob_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "blob_objects" ADD COLUMN "unreferenced_at" timestamp;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_object_id_blob_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "blob_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing v2 objects without live handles receive a fresh grace period when
-- maintenance is introduced. Legacy rows remain untouched.
UPDATE "blob_objects" AS o
SET "unreferenced_at" = now()
WHERE o."status" = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM "blobs" AS b
    WHERE b."object_id" = o."id" AND b."deleted_at" IS NULL
  );
