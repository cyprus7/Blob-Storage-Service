import http from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100
const BASE = `http://localhost:${PORT}`
const API_KEY = process.env.BLOB_API_KEY || 'dev-secret-key'

function waitForHealth(timeout = 20000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const attempt = async () => {
            try {
                const res = await httpGet('/health')
                if (res.status === 200) return resolve()
            } catch (e) {
                // ignore
            }
            if (Date.now() - start > timeout) return reject(new Error('timeout waiting for health'))
            setTimeout(attempt, 200)
        }
        attempt()
    })
}

function httpGet(path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.get(BASE + path, { headers: { 'x-api-key': API_KEY } }, (res) => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }))
        })
        req.on('error', reject)
    })
}

function httpRequest(method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const opts = new URL(BASE + path)
        const req = http.request({ method, hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search, headers }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(Buffer.from(c)))
            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }))
        })
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
    })
}

function buildMultipart(fieldName: string, filename: string, content: Buffer): { body: Buffer; contentType: string } {
    const boundary = '----NodeMultipart' + Math.random().toString(16).slice(2)
    const parts: Buffer[] = []
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    parts.push(header, content, footer)
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('E2E: blob flows', () => {
    let uploadedId: string | null = null

    beforeAll(async () => {
        await waitForHealth()
    }, 20000)

    it('upload -> returns 201 and info', async () => {
        const buf = Buffer.from('hello e2e')
        const { body, contentType } = buildMultipart('file', 'hello.txt', buf)

        const res = await httpRequest('POST', '/v1/blobs', {
            'Content-Type': contentType,
            'Content-Length': String(body.length),
            'x-api-key': API_KEY,
        }, body)

        expect(res.status).toBe(201)
        const json = JSON.parse(res.body.toString('utf8'))
        expect(json).toHaveProperty('id')
        expect(json).toHaveProperty('storageKey')
        expect(json.size).toBe(buf.length)
        uploadedId = json.id
    }, 20000)

    it('get info -> returns metadata', async () => {
        expect(uploadedId).toBeTruthy()
        const res = await httpRequest('GET', `/v1/blobs/${uploadedId}`, { 'x-api-key': API_KEY })
        expect(res.status).toBe(200)
        const json = JSON.parse(res.body.toString('utf8'))
        expect(json.id).toBe(uploadedId)
        expect(json.storageKey).toBeDefined()
    })

    it('get content -> returns uploaded bytes', async () => {
        expect(uploadedId).toBeTruthy()
        const res = await httpRequest('GET', `/v1/blobs/${uploadedId}/content`, { 'x-api-key': API_KEY })
        expect(res.status).toBe(200)
        expect(res.body.toString('utf8')).toBe('hello e2e')
    })

    it('soft delete -> returns deletedAt set', async () => {
        expect(uploadedId).toBeTruthy()
        const res = await httpRequest('DELETE', `/v1/blobs/${uploadedId}`, { 'x-api-key': API_KEY })
        expect(res.status).toBe(200)
        const json = JSON.parse(res.body.toString('utf8'))
        expect(json.deletedAt).not.toBeNull()
    })
})
