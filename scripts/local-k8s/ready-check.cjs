const expected = Number(process.argv[2])
if (![200, 503].includes(expected)) throw new Error('Expected readiness status must be 200 or 503')

async function main() {
  const health = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(10000) })
  if (health.status !== 200) throw new Error(`liveness returned ${health.status}, expected 200`)
  const ready = await fetch('http://127.0.0.1:3100/ready', { signal: AbortSignal.timeout(10000) })
  if (ready.status !== expected) throw new Error(`readiness returned ${ready.status}, expected ${expected}`)
  console.log(`PASS: /health=200, /ready=${ready.status}`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
