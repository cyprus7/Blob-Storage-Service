# Docker Desktop Kubernetes smoke

Run from PowerShell 7 on Windows with Docker Desktop Kubernetes enabled:

```powershell
pwsh -NoProfile -File scripts/local-k8s/run.ps1
```

The script explicitly uses Docker context `desktop-linux` and Kubernetes context
`docker-desktop`. It stops if the Kubernetes API endpoint differs from
`https://kubernetes.docker.internal:6443`; it never uses the current kubeconfig
context. It builds the service from this checkout, then creates a unique
`blob-smoke-<12 hex>` namespace containing ephemeral PostgreSQL and MinIO,
applies this checkout's SQL migrations, creates the bucket, and runs HTTP tests
through a localhost-only port-forward. PostgreSQL and MinIO data use `emptyDir`
and disappear with the namespace.

The smoke covers health and dependency readiness, API key rejection,
independent logical IDs for the
same bytes, parallel uploads sharing physical storage, metadata, download
headers and byte integrity, the 10 MiB upload limit, legacy ID deletion 409,
soft and hard deletion without breaking another ID, and reupload. The legacy
row comes from `legacy-fixture.sql` in the temporary PostgreSQL database. The
script uses a fresh random local API key and synthetic file bytes. By default,
it removes only the namespace it created, after checking its unique
`blob-smoke-run` label. Add `-KeepNamespace` to inspect a failing run. The
locally built image tag remains in Docker's cache.

No cluster outside Docker Desktop, external database, or real object store is
used. The service's existing Docker Compose helper is not part of this run.

To test the production SQL migration runner on a separate, empty local
PostgreSQL database:

```powershell
pwsh -NoProfile -File scripts/local-k8s/migrations-smoke.ps1
```

This creates another unique namespace. Kubernetes Jobs run the exact
`scripts/apply-migrations.sh` against the current SQL files: first apply,
idempotent repeat, then an intentionally invalid later migration. The check
requires a complete ledger, a failed negative Job, transaction rollback, and
no execution of the following migration. It cleans only its own labelled
namespace by default; `-KeepNamespace` preserves it for inspection.

After a full smoke run with `-KeepNamespace`, verify the opt-in GC command in
that same disposable namespace:

```powershell
pwsh -NoProfile -File scripts/local-k8s/gc-smoke.ps1 -Namespace blob-smoke-<12-hex>
```

This script accepts only a namespace with the smoke ownership label and a local
build image, then executes `gc-smoke.cjs` inside the blob-service pod. It tests
dry-run, active and legacy reference protection, the 24-hour grace period,
deletion of an eligible v2 object, and preservation of a real legacy S3 object
and ID. It leaves the namespace in place for inspection and cleanup.

Additional checks in the retained namespace:

```powershell
pwsh -NoProfile -File scripts/local-k8s/upgrade-smoke.ps1 -Namespace blob-smoke-<12-hex>
pwsh -NoProfile -File scripts/local-k8s/compat-smoke.ps1 -Namespace blob-smoke-<12-hex>
pwsh -NoProfile -File scripts/local-k8s/gc-smoke.ps1 -Namespace blob-smoke-<12-hex> -Scenario edge
pwsh -NoProfile -File scripts/local-k8s/e2e-smoke.ps1 -Namespace blob-smoke-<12-hex>
```

`upgrade-smoke.ps1` creates and removes a second database within the local
PostgreSQL Pod. It applies 0000 and 0001, inserts legacy, active v2, and orphan
v2 rows, then runs `npm run migrate:blob` from the runtime service image. It
checks 0002 backfill, legacy preservation, and `ON DELETE SET NULL` for a
soft-deleted handle. The first and repeated runtime migration commands can also
be checked against a fresh database in this namespace.

`compat-smoke.ps1` starts the cached pinned image
`ghcr.io/cyprus7/blob-storage-service:dce267c21c44b0e0696fd4e334bfe0fc388913d7`
with `imagePullPolicy: Never`. It uploads a new v2 ID through the current
service and verifies that both versions can read metadata and bytes for it and
for the real legacy fixture. It makes no old-image upload or delete request.

The GC `edge` scenario checks that a missing S3 upload remains `pending`, a
second GC process fails closed under the PostgreSQL advisory lock, retry after
unlock succeeds, and a new reference inserted after GC eligibility prevents
S3 deletion. The stock `npm run test:e2e` suite uses a localhost-only
port-forward and the ephemeral API key from the local Kubernetes Secret.

Finally, to test dependency outages:

```powershell
pwsh -NoProfile -File scripts/local-k8s/ready-failure-smoke.ps1 -Namespace blob-smoke-<12-hex>
```

It scales MinIO and PostgreSQL down and back up one at a time. It expects
`/health` 200 and `/ready` 503 during each outage, then `/ready` 200 after
recovery. Run this last: scaling these local `emptyDir` Pods to zero discards
their test data. The script recreates the MinIO bucket; if further database
tests are needed, run `npm run migrate:blob` in the local service Pod to restore
the empty PostgreSQL schema.

After a retained run, remove only its labelled namespace:

```powershell
pwsh -NoProfile -File scripts/local-k8s/cleanup.ps1 -Namespace blob-smoke-<12-hex>
```
