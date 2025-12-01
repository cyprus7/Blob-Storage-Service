import { GetBlobContentUseCase } from '../application/use-cases/get-blob-content.usecase'
import { BlobEntity } from '../domain/blob.entity'
import { NotFoundException } from '@nestjs/common'

describe('GetBlobContentUseCase (negative cases)', () => {
    it('propagates error when storage.getObjectStream throws', async () => {
        const props = {
            id: 'cneg1',
            hash: 'hneg',
            size: 4,
            mime: 'text/plain',
            storageKey: 'objects/cneg1',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockResolvedValue(entity),
        } as any

        const storageMock = {
            getObjectStream: jest.fn().mockRejectedValue(new Error('stream failure')),
        } as any

        const usecase = new GetBlobContentUseCase(repoMock, storageMock)

        await expect(usecase.execute(props.id)).rejects.toThrow('stream failure')
        expect(storageMock.getObjectStream).toHaveBeenCalledWith(props.storageKey)
    })

    it('throws NotFoundException when blob is deleted', async () => {
        const props = {
            id: 'cneg2',
            hash: 'hneg2',
            size: 2,
            mime: 'text/plain',
            storageKey: 'objects/cneg2',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: new Date(),
        }
        const entity = new BlobEntity({ ...props })
        const repoMock = { findById: jest.fn().mockResolvedValue(entity) } as any
        const storageMock = { getObjectStream: jest.fn() } as any
        const usecase = new GetBlobContentUseCase(repoMock, storageMock)

        await expect(usecase.execute(props.id)).rejects.toThrow(NotFoundException)
    })
})
