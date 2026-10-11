import { createHash } from 'crypto'
import { Readable } from 'stream'
import { BlobGcService } from '../maintenance/blob-gc.service'
import { BlobRepository, PhysicalBlob } from '../domain/ports/blob.repository'
import { BlobStoragePort } from '../domain/ports/blob-storage.port'

const bytes = Buffer.from('orphan bytes')
const hash = createHash('sha256').update(bytes).digest('hex')
const object: PhysicalBlob = {
    id: 'object-id', hash, size: bytes.length, mime: 'application/octet-stream',
    storageKey: `objects/sha256/v2/${hash.slice(0, 2)}/${hash}`,
    status: 'active', unreferencedAt: new Date('2025-01-01T00:00:00Z'),
}

function harness() {
    const repo = {
        listStalePending: jest.fn().mockResolvedValue([]),
        recoverPending: jest.fn().mockResolvedValue(true),
        listUntrackedOrphans: jest.fn().mockResolvedValue([]),
        markUnreferenced: jest.fn().mockResolvedValue(true),
        listDeleting: jest.fn().mockResolvedValue([]),
        getSafeDeleting: jest.fn().mockResolvedValue({ ...object, status: 'deleting' }),
        listEligibleForDeletion: jest.fn().mockResolvedValue([]),
        claimDeletion: jest.fn().mockResolvedValue({ ...object, status: 'deleting' }),
        finalizeDeletion: jest.fn().mockResolvedValue(true),
    }
    const storage = {
        getObjectStream: jest.fn().mockResolvedValue(Readable.from([bytes])),
        deleteObject: jest.fn().mockResolvedValue(undefined),
    }
    const gc = new BlobGcService(repo as unknown as BlobRepository, storage as unknown as BlobStoragePort)
    const options = { execute: true, now: new Date('2025-01-03T00:00:00Z') }
    return { repo, storage, gc, options }
}

describe('opt-in blob GC', () => {
    it('is read-only by default, even with eligible objects', async () => {
        const h = harness()
        h.repo.listEligibleForDeletion.mockResolvedValue([object])

        const result = await h.gc.run({ now: h.options.now })

        expect(result.mode).toBe('dry-run')
        expect(result.eligibleForDeletion).toBe(1)
        expect(h.repo.claimDeletion).not.toHaveBeenCalled()
        expect(h.repo.recoverPending).not.toHaveBeenCalled()
        expect(h.storage.deleteObject).not.toHaveBeenCalled()
    })

    it('keeps deleting state after S3 failure and retries idempotently next run', async () => {
        const h = harness()
        h.repo.listEligibleForDeletion.mockResolvedValueOnce([object]).mockResolvedValue([])
        h.repo.listDeleting.mockResolvedValueOnce([]).mockResolvedValue([{ ...object, status: 'deleting' }])
        h.storage.deleteObject.mockRejectedValueOnce(new Error('S3 unavailable'))

        const first = await h.gc.run(h.options)
        expect(first.errors).toEqual([expect.objectContaining({ operation: 'deleteObject', message: 'S3 unavailable' })])
        expect(h.repo.claimDeletion).toHaveBeenCalledTimes(1)
        expect(h.repo.finalizeDeletion).not.toHaveBeenCalled()

        const retry = await h.gc.run(h.options)
        expect(retry.deleted).toBe(1)
        expect(retry.errors).toHaveLength(0)
        expect(h.repo.getSafeDeleting).toHaveBeenCalledTimes(2)
        expect(h.storage.deleteObject).toHaveBeenCalledTimes(2)
        expect(h.repo.finalizeDeletion).toHaveBeenCalledTimes(1)
    })

    it('does not delete when a handle appears after candidate listing', async () => {
        const h = harness()
        h.repo.listEligibleForDeletion.mockResolvedValue([object])
        h.repo.claimDeletion.mockResolvedValue(null)

        const result = await h.gc.run(h.options)

        expect(result.skipped).toBe(1)
        expect(h.storage.deleteObject).not.toHaveBeenCalled()
        expect(h.repo.finalizeDeletion).not.toHaveBeenCalled()
    })

    it('checks complete pending S3 content before recovery, then starts a fresh grace period', async () => {
        const h = harness()
        h.repo.listStalePending.mockResolvedValue([{ ...object, status: 'pending' }])

        const result = await h.gc.run(h.options)

        expect(result.recoveredPending).toBe(1)
        expect(h.repo.recoverPending).toHaveBeenCalledWith(object.id, hash)
        expect(h.storage.deleteObject).not.toHaveBeenCalled()

        h.storage.getObjectStream.mockResolvedValue(Readable.from([Buffer.from('wrong bytes')]))
        const corrupt = await h.gc.run(h.options)
        expect(corrupt.recoveredPending).toBe(0)
        expect(corrupt.skipped).toBe(1)
        expect(h.repo.recoverPending).toHaveBeenCalledTimes(1)
    })

    it('leaves a pending reservation untouched when S3 could not provide the object', async () => {
        const h = harness()
        h.repo.listStalePending.mockResolvedValue([{ ...object, status: 'pending' }])
        h.storage.getObjectStream.mockRejectedValue(new Error('NoSuchKey'))

        const result = await h.gc.run(h.options)

        expect(result.recoveredPending).toBe(0)
        expect(result.errors).toEqual([expect.objectContaining({ operation: 'recoverPending', message: 'NoSuchKey' })])
        expect(h.repo.recoverPending).not.toHaveBeenCalled()
        expect(h.storage.deleteObject).not.toHaveBeenCalled()
    })

    it('never passes a legacy-looking key to S3 DELETE', async () => {
        const h = harness()
        const unsafe = { ...object, storageKey: `objects/sha256/${hash.slice(0, 2)}/${hash}` }
        h.repo.listEligibleForDeletion.mockResolvedValue([unsafe])
        h.repo.listDeleting.mockResolvedValue([{ ...unsafe, status: 'deleting' }])

        const result = await h.gc.run(h.options)

        expect(result.skipped).toBe(2)
        expect(h.repo.claimDeletion).not.toHaveBeenCalled()
        expect(h.storage.deleteObject).not.toHaveBeenCalled()
    })

    it('rechecks references on a previously claimed deleting row', async () => {
        const h = harness()
        h.repo.listDeleting.mockResolvedValue([{ ...object, status: 'deleting' }])
        h.repo.getSafeDeleting.mockResolvedValue(null)

        const result = await h.gc.run(h.options)

        expect(result.skipped).toBe(1)
        expect(h.storage.deleteObject).not.toHaveBeenCalled()
    })
})
