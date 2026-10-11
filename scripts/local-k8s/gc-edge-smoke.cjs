const assert = require('node:assert/strict')
const { randomBytes, createHash } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { Pool } = require('pg')
const {
  S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3')

if (!process.env.BLOB_PG_URL?.includes('@postgres:5432/blob_service') ||
    process.env.S3_ENDPOINT !== 'http://minio:9000') {
  throw new Error('GC edge smoke requires local PostgreSQL and MinIO')
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
const cli = 'dist/maintenance/blob-gc.js'
const gcArgs = [cli, '--execute', '--grace-hours=24', '--limit=100']

function fixture() {
  const bytes = randomBytes(256)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return { bytes, hash, key: `objects/sha256/v2/${hash.slice(0, 2)}/${hash}` }
}

function runGc() {
  const result = spawnSync(process.execPath, gcArgs, { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return result
}

function successfulGc(result) {
  assert.equal(result.status, 0, `GC stderr: ${result.stderr}`)
  const summary = JSON.parse(result.stdout.trim())
  assert.deepEqual(summary.errors, [])
  return summary
}

async function getObject(hash) {
  const { rows } = await pool.query('select status from blob_objects where hash = $1', [hash])
  return rows[0] || null
}

async function assertS3Exists(key) {
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
}

async function assertS3Missing(key) {
  try {
    await assertS3Exists(key)
    assert.fail(`S3 object ${key} still exists`)
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error
    assert.equal(error.$metadata?.httpStatusCode, 404)
  }
}

async function insertObject(object, status, age) {
  await pool.query(
    `insert into blob_objects(hash, size, mime, storage_key, status, updated_at, unreferenced_at)
     values($1, $2, 'application/octet-stream', $3, $4,
            now() - interval '25 hours', case when $5 then now() - interval '25 hours' else null end)`,
    [object.hash, object.bytes.length, object.key, status, age],
  )
}

async function pendingFailure() {
  const missing = fixture()
  await insertObject(missing, 'pending', false)
  const result = runGc()
  assert.equal(result.status, 1, 'missing pending S3 object must fail closed')
  const summary = JSON.parse(result.stdout.trim())
  assert.ok(summary.errors.some((error) => error.operation === 'recoverPending'))
  assert.equal((await getObject(missing.hash)).status, 'pending')
  await pool.query('delete from blob_objects where hash = $1', [missing.hash])
  console.log('PASS: missing S3 PUT leaves stale pending reservation pending')
}

async function globalLock() {
  const orphan = fixture()
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: orphan.key, Body: orphan.bytes }))
  await insertObject(orphan, 'active', true)
  const client = await pool.connect()
  try {
    const lock = await client.query('select pg_try_advisory_lock($1::integer,$2::integer) as acquired',
      [1195573249, 1112297282])
    assert.equal(lock.rows[0].acquired, true)
    try {
      const blocked = runGc()
      assert.equal(blocked.status, 1, 'second GC process must fail closed')
      assert.match(blocked.stderr, /Another blob GC process is already running/)
      assert.equal((await getObject(orphan.hash)).status, 'active')
      await assertS3Exists(orphan.key)
    } finally {
      const unlock = await client.query('select pg_advisory_unlock($1::integer,$2::integer) as released',
        [1195573249, 1112297282])
      assert.equal(unlock.rows[0].released, true)
    }
  } finally {
    client.release()
  }
  const summary = successfulGc(runGc())
  assert.ok(summary.deleted >= 1)
  assert.equal(await getObject(orphan.hash), null)
  await assertS3Missing(orphan.key)
  console.log('PASS: global GC lock blocks second execute and retry succeeds after release')
}

function startGcAsync() {
  const child = spawn(process.execPath, gcArgs)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
  return { child, completed }
}

async function waitForHashLockContention() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await pool.query(`select count(*)::int as total from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%pg_advisory_xact_lock%'`)
    if (rows[0].total > 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('GC did not reach the hash-lock contention point')
}

async function concurrentReference() {
  const object = fixture()
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: object.key, Body: object.bytes }))
  await insertObject(object, 'active', true)
  const client = await pool.connect()
  let running
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [object.hash])
    running = startGcAsync()
    await waitForHashLockContention()
    await client.query(
      `insert into blobs(hash, size, mime, storage_key, generation, object_id)
       select hash, size, mime, storage_key, 2, id from blob_objects where hash = $1`,
      [object.hash],
    )
    await client.query('commit')
    const result = await running.completed
    const summary = successfulGc(result)
    assert.equal(summary.deleted, 0)
    assert.ok(summary.skipped >= 1)
    assert.equal((await getObject(object.hash)).status, 'active')
    await assertS3Exists(object.key)
    console.log('PASS: new reference inserted after GC eligibility prevents S3 deletion')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    if (running) {
      running.child.kill()
      await running.completed.catch(() => {})
    }
    throw error
  } finally {
    client.release()
  }
  await pool.query('delete from blobs where hash = $1 and generation = 2', [object.hash])
  await pool.query('delete from blob_objects where hash = $1', [object.hash])
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }))
}

async function main() {
  await pendingFailure()
  await globalLock()
  await concurrentReference()
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => pool.end())
