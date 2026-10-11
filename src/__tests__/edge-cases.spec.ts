import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { GetBlobInfoUseCase } from '../application/use-cases/get-blob-info.usecase'
import { GetBlobContentUseCase } from '../application/use-cases/get-blob-content.usecase'
import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

const entity = new BlobEntity({
    id: 'v2', hash: 'hash', size: 2, mime: 'text/plain', storageKey: 'objects/key',
    createdAt: new Date(), lastUsedAt: null, deletedAt: null, generation: 2,
})

describe('Failure paths', () => {
    it('propagates logical handle insert failure after a successful S3 PUT', async () => {
        const repo = {
            prepareUpload: jest.fn().mockResolvedValue({
                object: { storageKey: 'objects/key', mime: 'text/plain' }, needsUpload: true,
            }),
            createLogicalBlob: jest.fn().mockRejectedValue(new Error('insert failed')),
        } as any
        const storage = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/key'),
            putObject: jest.fn().mockResolvedValue(undefined),
        } as any
        await expect(new UploadBlobUseCase(storage, repo).execute({
            buffer: Buffer.from('ok'), size: 2, mimetype: 'text/plain',
        } as Express.Multer.File)).rejects.toThrow('insert failed')
        expect(storage.putObject).toHaveBeenCalledTimes(1)
    })

    it('does not create a handle when S3 PUT fails', async () => {
        const repo = {
            prepareUpload: jest.fn().mockResolvedValue({
                object: { storageKey: 'objects/key', mime: 'text/plain' }, needsUpload: true,
            }),
            createLogicalBlob: jest.fn(),
        } as any
        const storage = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/key'),
            putObject: jest.fn().mockRejectedValue(new Error('transient put')),
        } as any
        await expect(new UploadBlobUseCase(storage, repo).execute({
            buffer: Buffer.from('ok'), size: 2, mimetype: 'text/plain',
        } as Express.Multer.File)).rejects.toThrow('transient put')
        expect(repo.createLogicalBlob).not.toHaveBeenCalled()
    })

    it('returns 404 when an active handle disappears before metadata touch', async () => {
        const repo = { touchActive: jest.fn().mockResolvedValue(null) } as any
        await expect(new GetBlobInfoUseCase(repo).execute(entity.id)).rejects.toThrow()
    })

    it('returns an opened content stream after touch', async () => {
        const stream = Buffer.from('ok')
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            touchActive: jest.fn().mockResolvedValue(entity),
        } as any
        const storage = { getObjectStream: jest.fn().mockResolvedValue(stream) } as any
        const result = await new GetBlobContentUseCase(repo, storage).execute(entity.id)
        expect(result.stream).toBe(stream)
        expect(storage.getObjectStream.mock.invocationCallOrder[0])
            .toBeLessThan(repo.touchActive.mock.invocationCallOrder[0])
    })

    it('propagates logical hard-delete database failure', async () => {
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            hardDeleteLogical: jest.fn().mockRejectedValue(new Error('repo delete failed')),
        } as any
        await expect(new DeleteBlobUseCase(repo).execute(entity.id, true)).rejects.toThrow('repo delete failed')
    })
})
