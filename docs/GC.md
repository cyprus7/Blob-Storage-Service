# Blob object garbage collection

The garbage collector is a manually invoked, opt-in command for removing
unreferenced **generation 2** objects from S3. HTTP DELETE removes or hides a
logical blob ID; it does not delete the physical object. No deployment starts
the collector or schedules it automatically.

## Before running

Do not run old and new blob-service replicas against the same database during
rollout. Drain all pre-generation-2 replicas before enabling the new service
or accepting DELETE from any client, and keep them out of service before GC.
The old implementation can return an existing generation-2 ID for a matching
upload and its `DELETE?force=true` can remove a shared S3 key without checking
other logical IDs. The database migration alone cannot make mixed versions safe.

1. Apply blob-service SQL migrations `0000`, `0001`, and `0002` in order. In
   particular, `0002` adds `blob_objects.unreferenced_at` and changes the
   logical ID foreign key to `ON DELETE SET NULL`. Follow the service
   [migration instructions](../README.md#quick-start) for an existing database.
2. Build the service with `npm run build`. Run the command from the service
   directory, with `BLOB_PG_URL` and the S3 settings for the **same** environment
   as the database: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`,
   and `S3_SECRET_KEY`. The normal SDK credential chain may be used where the
   service uses it. Load secrets using the environment's usual secret mechanism;
   do not put them in the command line, a committed file, or an operations log.
3. Start with a dry run and inspect its counts before using `--execute`. A dry
   run reads PostgreSQL, but does not change PostgreSQL or access S3.

```sh
node dist/maintenance/blob-gc.js
```

To perform one bounded cleanup pass after the review:

```sh
node dist/maintenance/blob-gc.js --execute --grace-hours=24 --limit=100
```

Use `node dist/maintenance/blob-gc.js --help` to display the accepted options.
The default grace period is 24 hours and cannot be set lower. `--limit` defaults
to 100, accepts values from 1 to 1000, and applies **separately** to each query
for stale pending, untracked orphan, deleting, and deletion-eligible objects.
It is not a total cap on objects handled in one pass. A session-level
PostgreSQL advisory lock covers the entire CLI pass; a second concurrent CLI
process exits with an error before touching objects. Run another dry run after
a failure or an unexpectedly large candidate count.

The command writes one JSON summary to standard output. `mode`, `cutoff`,
`stalePending`, `untrackedOrphans`, `retryingDeletion`, and
`eligibleForDeletion` describe the selected groups. `recoveredPending`,
`markedUnreferenced`, `deleted`, and `skipped` describe outcomes;
`errors` is an array of per-object errors. A dry run reports group counts and
zeros for outcomes; it does not list object IDs or verify S3 bytes. Exit status
0 means the pass completed without errors. Exit status 1 means an invalid
argument, a PostgreSQL failure, or a recorded S3 or object processing error.
Invalid arguments and startup failures are written to standard error and may
not produce a JSON summary.

## What the collector can touch

The collector operates on `blob_objects` introduced for generation 2 uploads.
Before S3 DELETE, it requires the exact key
`objects/sha256/v2/<first-two-hash-characters>/<64-character-hex-hash>` and
rechecks logical references. It does not scan the bucket for arbitrary keys.
Legacy `blobs` rows have no `object_id`; their historical S3 keys are outside
this cleanup contract. A legacy row sharing a candidate key also blocks its
deletion. Legacy IDs and keys require a separate, explicit migration or
retention decision.

| Object state | Treatment |
| --- | --- |
| `active` with any active logical ID | Retained. A deleted logical ID does not make a shared object eligible while another active ID refers to it. |
| `active` with no blocking logical references | Its `unreferenced_at` is set when the last active ID is deleted. Older orphan rows without that timestamp are marked on an execution pass. Deletion is eligible only after the timestamp passes the grace cutoff and a fresh reference check. |
| `pending` older than the grace cutoff | On execution, stream S3 content and compare its size and SHA-256 with the database record. Valid content is restored to `active`, with a new unreferenced timestamp. Invalid content is skipped; an S3 read failure is reported in `errors`. The collector does not remove these pending rows or their keys. |
| `deleting` | A previous deletion pass was interrupted. An execution pass retries S3 deletion and database finalization after another reference check. |

The execution pass rechecks references before claiming deletion and again
before S3 DELETE. S3 deletion and PostgreSQL updates cannot commit atomically;
the `deleting` state is the retry marker after an interrupted pass. An S3 delete
failure retains that state for retry. The command never deletes logical IDs.

## Operational checks

- Review the dry-run counts by state and confirm the target database and bucket
  before using `--execute`.
- After an execution pass, run another dry run. Investigate recurring `pending`
  or `deleting` entries and any S3 or PostgreSQL errors before increasing the
  limit.
- Keep backups and object-store retention appropriate to the environment. A
  successful S3 deletion is irreversible unless the bucket has versioning or a
  separate backup.

This tool does not collect legacy objects, change HTTP API contracts, or
automatically reconcile external references held by callers. See the
[service README](../README.md#delete-blob) for the logical DELETE contract.
