import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const baseUrl = process.env.BLOB_SMOKE_BASE_URL
const apiKey = process.env.BLOB_SMOKE_API_KEY
if (!baseUrl || !apiKey) {
  throw new Error('BLOB_SMOKE_BASE_URL and BLOB_SMOKE_API_KEY are required')
}

const path = (suffix) => `${baseUrl}${suffix}`
const authorized = { 'X-API-KEY': apiKey }
const expectStatus = (response, status, operation) => {
  assert.equal(response.status, status, `${operation}: expected HTTP ${status}, got ${response.status}`)
}

const payload = Buffer.concat([Buffer.from('blob k8s smoke\n'), randomBytes(65536)])
const hash = createHash('sha256').update(payload).digest('hex')
const legacyId = '00000000-0000-4000-8000-000000000001'

async function upload(bytes = payload) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'smoke.bin')
  return fetch(path('/v1/blobs'), { method: 'POST', headers: authorized, body: form })
}

async function uploadInfo() {
  const response = await upload()
  expectStatus(response, 201, 'upload')
  return response.json()
}

async function content(id, operation) {
  const response = await fetch(path(`/v1/blobs/${id}/content`), { headers: authorized })
  expectStatus(response, 200, operation)
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/i)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), 'sandbox')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const downloaded = Buffer.from(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), hash)
}

const health = await fetch(path('/health'))
expectStatus(health, 200, 'health')
assert.equal((await health.json()).status, 'ok')
const readiness = await fetch(path('/ready'))
expectStatus(readiness, 200, 'readiness')

const unauthenticated = await fetch(path('/v1/blobs/00000000-0000-0000-0000-000000000000'))
assert.ok([401, 403].includes(unauthenticated.status), `unauthenticated request returned ${unauthenticated.status}`)
const wrongKey = await fetch(path('/v1/blobs/00000000-0000-0000-0000-000000000000'), {
  headers: { 'X-API-KEY': 'wrong-key' },
})
assert.ok([401, 403].includes(wrongKey.status), `wrong API key returned ${wrongKey.status}`)

const first = await uploadInfo()
assert.match(first.id, /^[0-9a-f-]{36}$/i)
assert.equal(first.hash, hash)
assert.equal(Number(first.size), payload.length)
assert.equal(first.mime, 'application/octet-stream')
assert.equal(typeof first.storageKey, 'string')

const second = await uploadInfo()
assert.notEqual(second.id, first.id, 'duplicate bytes need an independent logical id')
assert.equal(second.storageKey, first.storageKey, 'duplicate bytes should share physical storage')

const parallelResponses = await Promise.all([upload(), upload(), upload()])
for (const response of parallelResponses) expectStatus(response, 201, 'parallel upload')
const parallel = await Promise.all(parallelResponses.map((response) => response.json()))
assert.equal(new Set([first.id, second.id, ...parallel.map((item) => item.id)]).size, 5)
assert.ok(parallel.every((item) => item.storageKey === first.storageKey))

const infoResponse = await fetch(path(`/v1/blobs/${first.id}`), { headers: authorized })
expectStatus(infoResponse, 200, 'metadata')
assert.equal((await infoResponse.json()).id, first.id)
await content(first.id, 'content')

const oversize = await upload(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
expectStatus(oversize, 413, 'oversized upload')

const legacySoftDelete = await fetch(path(`/v1/blobs/${legacyId}`), { method: 'DELETE', headers: authorized })
expectStatus(legacySoftDelete, 409, 'legacy soft delete')
const legacyHardDelete = await fetch(path(`/v1/blobs/${legacyId}?force=true`), { method: 'DELETE', headers: authorized })
expectStatus(legacyHardDelete, 409, 'legacy hard delete')

const softDelete = await fetch(path(`/v1/blobs/${first.id}`), { method: 'DELETE', headers: authorized })
expectStatus(softDelete, 200, 'soft delete')
assert.ok((await softDelete.json()).deletedAt)
expectStatus(await fetch(path(`/v1/blobs/${first.id}`), { headers: authorized }), 404, 'deleted metadata')
expectStatus(await fetch(path(`/v1/blobs/${first.id}/content`), { headers: authorized }), 404, 'deleted content')
await content(second.id, 'surviving duplicate after soft delete')

const hardDelete = await fetch(path(`/v1/blobs/${second.id}?force=true`), { method: 'DELETE', headers: authorized })
expectStatus(hardDelete, 200, 'hard delete')
expectStatus(await fetch(path(`/v1/blobs/${second.id}`), { headers: authorized }), 404, 'hard-deleted metadata')
await content(parallel[0].id, 'surviving duplicate after hard delete')

const reuploaded = await uploadInfo()
assert.notEqual(reuploaded.id, first.id, 'upload after delete needs a fresh logical id')
assert.equal(reuploaded.storageKey, first.storageKey)
await content(reuploaded.id, 'content after reupload')

console.log('PASS: health, auth, logical IDs, parallel dedup, metadata, content headers and bytes, 10 MiB cap, legacy 409, independent delete, reupload')
