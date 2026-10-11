CREATE TABLE blob_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO blob_schema_migrations(name) VALUES
  ('0000_curious_piledriver.sql'),
  ('0001_swift_crusher_hogan.sql');

INSERT INTO blobs(id, hash, size, mime, storage_key, generation) VALUES (
  '00000000-0000-4000-8000-000000000111',
  repeat('a', 64), 3, 'text/plain',
  'objects/sha256/aa/legacy-migration-fixture.txt', 1
);

INSERT INTO blob_objects(id, hash, size, mime, storage_key, status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000101', repeat('b', 64), 5, 'text/plain',
   'objects/sha256/v2/bb/active-migration-fixture', 'active', now() - interval '2 days', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000102', repeat('c', 64), 6, 'text/plain',
   'objects/sha256/v2/cc/orphan-migration-fixture', 'active', now() - interval '2 days', now() - interval '2 days');

INSERT INTO blobs(id, hash, size, mime, storage_key, generation, object_id, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000201', repeat('b', 64), 5, 'text/plain',
   'objects/sha256/v2/bb/active-migration-fixture', 2, '00000000-0000-4000-8000-000000000101', NULL),
  ('00000000-0000-4000-8000-000000000202', repeat('c', 64), 6, 'text/plain',
   'objects/sha256/v2/cc/orphan-migration-fixture', 2, '00000000-0000-4000-8000-000000000102', now() - interval '1 day');
