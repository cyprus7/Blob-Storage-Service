import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

describe('DeleteBlobUseCase (negative cases)', () => {
    it('propagates error when storage.deleteObject fails on hard delete', async () => {
        const props = {
            id: 'dneg1',
            hash: 'hdneg',
            size: 7,
            mime: 'image/png',
            storageKey: 'objects/dneg1',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            delete: jest.fn().mockResolvedValue(undefined),
        } as any

        const storageMock = { deleteObject: jest.fn().mockRejectedValue(new Error('delete failed')) } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        await expect(usecase.execute(props.id, true)).rejects.toThrow('delete failed')
        expect(storageMock.deleteObject).toHaveBeenCalledWith(props.storageKey)
    })

    it('propagates error when repo.update fails during soft delete', async () => {
        const props = {
            id: 'dneg2',
            hash: 'hdneg2',
            size: 9,
            mime: 'text/plain',
            storageKey: 'objects/dneg2',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockRejectedValue(new Error('update failed')),
        } as any

        const storageMock = { deleteObject: jest.fn() } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        await expect(usecase.execute(props.id, false)).rejects.toThrow('update failed')
        expect(repoMock.update).toHaveBeenCalled()
    })
})
