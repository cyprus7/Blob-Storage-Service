import { GetBlobInfoUseCase } from '../application/use-cases/get-blob-info.usecase'
import { BlobEntity } from '../domain/blob.entity'
import { NotFoundException } from '@nestjs/common'

describe('GetBlobInfoUseCase', () => {
    it('returns info and updates lastUsedAt when blob exists', async () => {
        const props = {
            id: 'b1',
            hash: 'h1',
            size: 123,
            mime: 'image/png',
            storageKey: 'objects/1',
            createdAt: new Date('2020-01-01T00:00:00.000Z'),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockImplementation(async (e: any) => e),
        } as any

        const usecase = new GetBlobInfoUseCase(repoMock)

        const dto = await usecase.execute(props.id)

        expect(repoMock.findById).toHaveBeenCalledWith(props.id)
        expect(repoMock.update).toHaveBeenCalled()
        expect(dto.id).toBe(props.id)
        expect(dto.hash).toBe(props.hash)
        expect(dto.size).toBe(props.size)
        expect(dto.createdAt).toBe(props.createdAt.toISOString())
        expect(dto.lastUsedAt).not.toBeNull()
    })

    it('throws NotFoundException when blob not found', async () => {
        const repoMock = { findById: jest.fn().mockResolvedValue(null) } as any
        const usecase = new GetBlobInfoUseCase(repoMock)

        await expect(usecase.execute('missing')).rejects.toThrow(NotFoundException)
    })

    it('throws NotFoundException when blob is soft-deleted', async () => {
        const props = {
            id: 'b2',
            hash: 'h2',
            size: 10,
            mime: 'text/plain',
            storageKey: 'objects/2',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: new Date(),
        }
        const entity = new BlobEntity({ ...props })

        const repoMock = { findById: jest.fn().mockResolvedValue(entity) } as any
        const usecase = new GetBlobInfoUseCase(repoMock)

        await expect(usecase.execute(props.id)).rejects.toThrow(NotFoundException)
    })
})
