import http from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100
const BASE = `http://localhost:${PORT}`

function httpGet(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(BASE + path, (res) => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
        })
        req.on('error', reject)
    })
}

describe('E2E: health endpoint', () => {
    it('responds 200 on /health', async () => {
        const res = await httpGet('/health')
        expect(res.status).toBe(200)
        // body can be a JSON or string "ok"
        expect(typeof res.body).toBe('string')
    }, 20000)
})
