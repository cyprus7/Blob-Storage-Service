const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')

const baseNew = 'http://127.0.0.1:3100'
const baseOld = 'http://old-blob-service:3100'
const legacyId = '00000000-0000-4000-8000-000000000001'
const headers = { 'X-API-KEY': process.env.BLOB_API_KEY }

async function waitForOldService() {
  let lastError
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const health = await fetch(`${baseOld}/health`)
      if (health.status === 200) return
      lastError = new Error(`old service health returned ${health.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError
}

async function read(baseUrl, id, expectedBytes) {
  const info = await fetch(`${baseUrl}/v1/blobs/${id}`, { headers })
  assert.equal(info.status, 200, `${baseUrl} info ${id}`)
  assert.equal((await info.json()).id, id)
  const content = await fetch(`${baseUrl}/v1/blobs/${id}/content`, { headers })
  assert.equal(content.status, 200, `${baseUrl} content ${id}`)
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), expectedBytes)
}

async function main() {
  await waitForOldService()
  const bytes = randomBytes(256)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'compat.bin')
  const upload = await fetch(`${baseNew}/v1/blobs`, { method: 'POST', headers, body: form })
  const payload = await upload.text()
  assert.equal(upload.status, 201, `new upload: ${payload}`)
  const v2 = JSON.parse(payload)
  assert.equal(v2.hash, createHash('sha256').update(bytes).digest('hex'))

  const legacyBytes = Buffer.from('legacy GC preservation fixture\n')
  await read(baseNew, legacyId, legacyBytes)
  await read(baseOld, legacyId, legacyBytes)
  await read(baseNew, v2.id, bytes)
  await read(baseOld, v2.id, bytes)
  console.log('PASS: current and pinned old image GET metadata/content for legacy and v2 IDs after 0002')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
