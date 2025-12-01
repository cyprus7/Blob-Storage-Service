# Blob Storage Service

Standalone **Blob Storage Service** built with NestJS, Drizzle ORM and S3-compatible storage (MinIO, AWS S3, etc.).

This service is designed to be used **internally between services** as a generic blob storage:
- You upload files once and receive a `blob id`.
- Any other service can then use this `blob id` to fetch metadata or stream content.
- SHA-256 hash + size is used for deduplication.

All endpoints are protected by a simple inter-service auth via `X-API-KEY` header.

---

## Features

- **Upload** file with SHA-256 deduplication.
- **Get metadata** for a blob.
- **Stream content** by ID.
- **Soft delete** (mark as deleted) or **hard delete** (remove from storage and DB).
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

4. Run migrations (later, once you generate them via Drizzle) or create the `blobs` table manually based on `src/db/schema.ts`.

5. Start the service:

```bash
npm run build
npm run start:dev
```

6. Swagger UI:

- Available at: `http://localhost:3100/docs`

> All requests must include `X-API-KEY: <your BLOB_API_KEY>` header.

---

## HTTP API (Summary)

All routes are prefixed with `/v1/blobs` and require `X-API-KEY`.

### Upload blob

**POST** `/v1/blobs`

- Content-Type: `multipart/form-data`
- Field: `file` (binary)

Response `201`:

```json
{
  "id": "uuid",
  "hash": "sha256...",
  "size": 12345,
  "mime": "image/png",
  "storageKey": "objects/sha256/ab/ab12cd....png",
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

### Delete blob

**DELETE** `/v1/blobs/{id}?force=false`

- `force=false` (default): soft delete (sets `deletedAt`).
- `force=true`: hard delete (removes from storage and DB).

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

You can store this `blob id` in your own domain models (user avatars, resumes, quest media, etc.).
