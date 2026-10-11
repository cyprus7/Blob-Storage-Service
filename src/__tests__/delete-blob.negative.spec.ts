import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

const entity = new BlobEntity({
    id: 'v2', hash: 'hash', size: 7, mime: 'image/png', storageKey: 'objects/shared',
    createdAt: new Date(), lastUsedAt: null, deletedAt: null, generation: 2,
})

describe('DeleteBlobUseCase failures', () => {
    it('propagates a hard-delete database failure without touching S3', async () => {
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            hardDeleteLogical: jest.fn().mockRejectedValue(new Error('delete failed')),
        } as any
        await expect(new DeleteBlobUseCase(repo).execute(entity.id, true)).rejects.toThrow('delete failed')
        expect(repo.hardDeleteLogical).toHaveBeenCalledWith(entity.id)
    })

    it('propagates a soft-delete database failure', async () => {
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            softDeleteLogical: jest.fn().mockRejectedValue(new Error('update failed')),
        } as any
        await expect(new DeleteBlobUseCase(repo).execute(entity.id, false)).rejects.toThrow('update failed')
    })
})
