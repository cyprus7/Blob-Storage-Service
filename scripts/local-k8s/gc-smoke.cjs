const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Pool } = require('pg')
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')

if (!process.env.BLOB_PG_URL?.includes('@postgres:5432/blob_service')) {
  throw new Error('GC smoke requires the local PostgreSQL service')
}
if (process.env.S3_ENDPOINT !== 'http://minio:9000') {
  throw new Error('GC smoke requires the local MinIO service')
}

const pool = new Pool({ connectionString: process.env.BLOB_PG_URL })
const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
})
const bucket = process.env.S3_BUCKET
const legacyId = '00000000-0000-4000-8000-000000000001'
const legacyAliasId = '00000000-0000-4000-8000-000000000002'
const apiUrl = 'http://127.0.0.1:3100'

function gc(execute = false) {
  const args = ['dist/maintenance/blob-gc.js', '--grace-hours=24', '--limit=100']
  if (execute) args.push('--execute')
  const output = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 }).trim()
  const summary = JSON.parse(output)
  assert.equal(summary.mode, execute ? 'execute' : 'dry-run')
  assert.deepEqual(summary.errors, [])
  return summary
}

async function objectCount() {
  const { rows } = await pool.query('select count(*)::int as total from blob_objects')
  return rows[0].total
}

async function legacyContent(id, expectedBytes) {
  const response = await fetch(`${apiUrl}/v1/blobs/${id}/content`, {
    headers: { 'X-API-KEY': process.env.BLOB_API_KEY },
  })
  assert.equal(response.status, 200, `legacy GET ${id}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(bytes, expectedBytes)
}

async function headExists(key) {
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
}

async function headMissing(key) {
  try {
    await headExists(key)
    assert.fail(`S3 object ${key} still exists`)
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error
    assert.ok([404, 'NotFound', 'NoSuchKey'].includes(error.$metadata?.httpStatusCode) ||
      ['NotFound', 'NoSuchKey'].includes(error.name), `unexpected S3 error: ${error.name}`)
  }
}

async function main() {
  const { rows: objects } = await pool.query('select id, hash, size, mime, storage_key from blob_objects where status = $1', ['active'])
  assert.equal(objects.length, 1, 'fresh HTTP smoke must leave one active v2 object')
  const object = objects[0]
  const { rows: handles } = await pool.query('select id from blobs where generation = 2 and deleted_at is null')
  assert.ok(handles.length > 0, 'fresh HTTP smoke must leave active v2 handles')
  const v2Response = await fetch(`${apiUrl}/v1/blobs/${handles[0].id}/content`, {
    headers: { 'X-API-KEY': process.env.BLOB_API_KEY },
  })
  assert.equal(v2Response.status, 200)
  const v2Bytes = Buffer.from(await v2Response.arrayBuffer())
  assert.equal(createHash('sha256').update(v2Bytes).digest('hex'), object.hash)

  const legacyBytes = Buffer.from('legacy GC preservation fixture\n')
  const legacyHash = createHash('sha256').update(legacyBytes).digest('hex')
  const legacyKey = `objects/sha256/${legacyHash.slice(0, 2)}/${legacyHash}.txt`
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: legacyKey, Body: legacyBytes, ContentType: 'text/plain' }))
  await pool.query(
    'update blobs set hash = $1, size = $2, mime = $3, storage_key = $4 where id = $5 and generation = 1',
    [legacyHash, legacyBytes.length, 'text/plain', legacyKey, legacyId],
  )
  await pool.query(
    'insert into blobs(id, hash, size, mime, storage_key, generation) values($1, $2, $3, $4, $5, 1)',
    [legacyAliasId, object.hash, object.size, object.mime, object.storage_key],
  )
  await legacyContent(legacyId, legacyBytes)

  const initialDryRun = gc()
  assert.equal(initialDryRun.deleted, 0)
  assert.equal(await objectCount(), 1)

  // Even an artificially old timestamp cannot override live v2 handles.
  await pool.query("update blob_objects set unreferenced_at = now() - interval '25 hours' where id = $1", [object.id])
  const activeProtected = gc(true)
  assert.equal(activeProtected.deleted, 0)
  assert.equal(await objectCount(), 1)

  // A legacy handle sharing the key blocks removal after all v2 handles close.
  await pool.query('update blobs set deleted_at = now() where generation = 2 and deleted_at is null')
  await legacyContent(legacyAliasId, v2Bytes)
  const legacyProtected = gc(true)
  assert.equal(legacyProtected.deleted, 0)
  assert.equal(await objectCount(), 1)
  await legacyContent(legacyId, legacyBytes)
  await headExists(object.storage_key)

  // With all v2 handles closed and the alias removed, a fresh timestamp must
  // still honor the 24-hour grace period. Dry-run must not mutate anything.
  await pool.query('delete from blobs where id = $1', [legacyAliasId])
  await pool.query('update blob_objects set unreferenced_at = now() where id = $1', [object.id])
  const graceDryRun = gc()
  assert.equal(graceDryRun.eligibleForDeletion, 0)
  const graceExecute = gc(true)
  assert.equal(graceExecute.deleted, 0)
  assert.equal(await objectCount(), 1)

  await pool.query("update blob_objects set unreferenced_at = now() - interval '25 hours' where id = $1", [object.id])
  const eligibleDryRun = gc()
  assert.equal(eligibleDryRun.eligibleForDeletion, 1)
  assert.equal(await objectCount(), 1)
  const deleted = gc(true)
  assert.equal(deleted.deleted, 1)
  assert.equal(await objectCount(), 0)
  await headMissing(object.storage_key)

  // The original v1 key and its logical ID must survive all GC phases.
  await headExists(legacyKey)
  await legacyContent(legacyId, legacyBytes)
  const { rows: legacyRows } = await pool.query('select generation from blobs where id = $1', [legacyId])
  assert.equal(legacyRows[0].generation, 1)

  console.log('PASS: GC dry-run, active/legacy reference protection, 24h grace, v2 deletion, legacy S3+ID preservation')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => pool.end())
