# Blob Storage Service

Standalone **Blob Storage Service** built with NestJS, Drizzle ORM and S3-compatible storage (MinIO, AWS S3, etc.).

This service is designed to be used **internally between services** as a generic blob storage:
- Every upload receives its own logical `blob id`.
- Services use that ID to fetch metadata or stream content.
- Identical bytes share a physical S3 object by SHA-256 hash + size. Deleting one
  logical ID cannot remove another upload's content.

All endpoints are protected by a simple inter-service auth via `X-API-KEY` header.
The service is not multi-tenant: one `BLOB_API_KEY` authorizes access to every
blob ID and operation on that instance. Use separate service instances, keys,
databases, and buckets for clients across different trust boundaries. Do not
use blob IDs or the API key as a per-user authorization mechanism.

---

## Features

- **Upload** file with SHA-256 deduplication.
- **Get metadata** for a blob.
- **Stream content** by ID.
- **Soft delete** or **hard delete** of a logical ID. Neither HTTP operation
  removes shared S3 content.
- **Clean architecture**:
  - Domain (entities + ports),
  - Application (use-cases),
  - Infrastructure (S3 & Postgres/Drizzle),
  - Interface (NestJS HTTP controllers).

---

## Quick start

1. Copy environment file:

```bash
cp .env.example .env
```

2. Adjust variables in `.env`:

- `BLOB_PG_URL` — Postgres connection string.
- `S3_*` — your S3/MinIO configuration.
- `BLOB_API_KEY` — shared secret for inter-service access.

3. Install dependencies:

```bash
npm install
```

4. Run the numbered SQL migrations before starting the new image:

```bash
npm run migrate:blob
```

`migrate:blob` needs `psql` in `PATH` and `BLOB_PG_URL`. The Docker image
includes `psql` and the migrations, so the same command works in the Kubernetes
migration Job. The runner records applied files in `blob_schema_migrations` and
stops on any SQL error. Existing databases that already have `blobs` but no
migration ledger must be inspected and baselined for `0000` before using this
runner; do not rerun `0000` against an existing table or suppress its error.
Compare the existing table and indexes with
[`0000_curious_piledriver.sql`](migrations/blob-service/0000_curious_piledriver.sql)
first. If they match, an operator can record that migration without replaying
it:

```bash
psql "$BLOB_PG_URL" -v ON_ERROR_STOP=1 -c '\d+ blobs'
psql "$BLOB_PG_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$ BEGIN
  IF to_regclass('blobs') IS NULL THEN
    RAISE EXCEPTION 'blobs table is missing; do not baseline 0000';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS blob_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO blob_schema_migrations(name)
VALUES ('0000_curious_piledriver.sql')
ON CONFLICT (name) DO NOTHING;
COMMIT;
SQL
npm run migrate:blob
```

Migrations `0001` and `0002` retain existing IDs and storage keys. Drain all
pre-generation-2 replicas before serving the new version: mixed versions can
reuse new logical IDs or delete shared S3 content through the old hard DELETE.

5. Start the service:

```bash
npm run build
npm run start:dev
```

6. Swagger UI:

- Available at: `http://localhost:3100/docs`

> All requests must include `X-API-KEY: <your BLOB_API_KEY>` header.

`/health` is a process liveness check. `/ready` checks PostgreSQL and the S3
bucket and returns 503 when either dependency is unavailable. Configure
readiness probes to use `/ready` only after the new image is deployed. Before
switching the Helm probe, verify that the service's S3 credentials can perform
`HeadBucket` on the configured bucket; otherwise healthy pods will stay unready.

---

## HTTP API (Summary)

All routes are prefixed with `/v1/blobs` and require `X-API-KEY`.

### Upload blob

**POST** `/v1/blobs`

- Content-Type: `multipart/form-data`
- Field: `file` (binary)
- Maximum file size: 10 MiB. Larger files receive HTTP 413. The default
  per-process upload concurrency limit is four; tune it with
  `BLOB_MAX_CONCURRENT_UPLOADS` according to the pod memory limit.

Response `201`:

```json
{
  "id": "uuid",
  "hash": "sha256...",
  "size": 12345,
  "mime": "image/png",
  "storageKey": "objects/sha256/v2/ab/ab12cd...",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "lastUsedAt": "2025-01-01T00:00:00.000Z",
  "deletedAt": null
}
```

### Get blob metadata

**GET** `/v1/blobs/{id}`

Response `200`: same JSON as above.

### Stream blob content

**GET** `/v1/blobs/{id}/content`

- Streams the binary content.
- `Content-Type` is set from stored `mime`.
- The response is a download (`Content-Disposition: attachment`) with
  `X-Content-Type-Options: nosniff` and a sandboxed content policy.

### Delete blob

**DELETE** `/v1/blobs/{id}?force=false`

- `force=false` (default): soft delete of this logical ID (`deletedAt`).
- `force=true`: remove this logical ID from PostgreSQL.
- Physical S3 data is retained for a separate, reference-aware cleanup process.
  An opt-in [GC CLI](docs/GC.md) is available after migration `0002`; no
  deployment schedules or starts it automatically.
- IDs created before migration `0001` may have external shared references;
  both DELETE variants return HTTP 409 for these legacy IDs. Existing GET
  routes remain available.

Response `200`: blob metadata (last known state).

---

## Using from other services

Example (Node / Axios):

```ts
import axios from "axios";

const BLOB_SERVICE_URL = "http://blob-service:3100";
const API_KEY = process.env.BLOB_API_KEY;

async function uploadAvatar(file: Buffer, filename: string, mime: string) {
  const form = new FormData();
  form.append("file", new Blob([file]), filename);

  const res = await axios.post(`${BLOB_SERVICE_URL}/v1/blobs`, form, {
    headers: {
      ...form.getHeaders?.(),
      "X-API-KEY": API_KEY,
    },
  });

  return res.data.id as string; // blob id
}
```

Store this `blob id` in the corresponding domain record (user avatar, resume,
quest media, etc.). Repeated uploads of identical bytes return distinct IDs
with a shared `storageKey`; callers must not assume equal bytes mean equal IDs.
