import { createHash } from 'crypto'
import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'
import type { PhysicalBlob } from '../domain/ports/blob.repository'

function makeHarness() {
    const bytes = Buffer.from('shared content')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const storageKey = `objects/sha256/${hash.slice(0, 2)}/${hash}`
    const object: PhysicalBlob = {
        id: 'object-1', hash, size: bytes.length, mime: 'text/plain', storageKey, status: 'pending',
    }
    const storedKeys = new Set<string>()
    let nextId = 0
    const storage = {
        buildKeyFromHash: jest.fn().mockReturnValue(storageKey),
        putObject: jest.fn().mockImplementation(async ({ key }: { key: string }) => {
            await Promise.resolve()
            storedKeys.add(key)
        }),
    } as any
    const repo = {
        prepareUpload: jest.fn().mockImplementation(async () => ({
            object: { ...object }, needsUpload: object.status !== 'active',
        })),
        createLogicalBlob: jest.fn().mockImplementation(async (_hash: string, _size: number, mime: string, uploaded: boolean) => {
            if (object.status !== 'active' && !uploaded) throw new Error('Cannot activate without S3 PUT')
            object.status = 'active'
            return new BlobEntity({
                id: `blob-${++nextId}`, hash, size: bytes.length, mime,
                storageKey, createdAt: new Date(), lastUsedAt: null, deletedAt: null,
                generation: 2, objectId: object.id,
            })
        }),
    } as any
    const file = { buffer: bytes, size: bytes.length, mimetype: 'text/plain' } as Express.Multer.File
    return { useCase: new UploadBlobUseCase(storage, repo), file, repo, storage, storedKeys, storageKey }
}

describe('independent logical handles', () => {
    it('reuses an active physical object while returning a new ID', async () => {
        const h = makeHarness()
        const first = await h.useCase.execute(h.file)
        const second = await h.useCase.execute(h.file)

        expect(first.info.id).not.toBe(second.info.id)
        expect(first.info.storageKey).toBe(second.info.storageKey)
        expect(h.storage.putObject).toHaveBeenCalledTimes(1)
        expect(second.deduplicated).toBe(true)
    })

    it('keeps MIME on each logical handle when physical bytes are shared', async () => {
        const h = makeHarness()
        const first = await h.useCase.execute(h.file)
        const second = await h.useCase.execute({ ...h.file, mimetype: 'application/pdf' })

        expect(first.info.mime).toBe('text/plain')
        expect(second.info.mime).toBe('application/pdf')
        expect(first.info.storageKey).toBe(second.info.storageKey)
        expect(h.storage.putObject).toHaveBeenCalledTimes(1)
    })

    it('retries an interrupted pending upload without creating a broken handle', async () => {
        const h = makeHarness()
        h.storage.putObject.mockRejectedValueOnce(new Error('S3 unavailable'))

        await expect(h.useCase.execute(h.file)).rejects.toThrow('S3 unavailable')
        expect(h.repo.createLogicalBlob).not.toHaveBeenCalled()

        const retry = await h.useCase.execute(h.file)
        expect(retry.info.id).toBe('blob-1')
        expect(h.storage.putObject).toHaveBeenCalledTimes(2)
        expect(h.storedKeys).toEqual(new Set([h.storageKey]))
    })

    it('allows concurrent identical uploads without shared logical IDs or S3 keys', async () => {
        const h = makeHarness()
        const results = await Promise.all(Array.from({ length: 12 }, () => h.useCase.execute(h.file)))

        expect(new Set(results.map((result) => result.info.id)).size).toBe(12)
        expect(new Set(results.map((result) => result.info.storageKey))).toEqual(new Set([h.storageKey]))
        expect(h.storedKeys).toEqual(new Set([h.storageKey]))
        expect(h.repo.createLogicalBlob).toHaveBeenCalledTimes(12)
    })
})
