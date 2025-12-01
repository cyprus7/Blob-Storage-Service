import { Readable } from 'stream'
import { GetBlobContentUseCase } from '../application/use-cases/get-blob-content.usecase'
import { BlobEntity } from '../domain/blob.entity'
import { NotFoundException } from '@nestjs/common'

describe('GetBlobContentUseCase', () => {
    it('returns info and stream when blob exists', async () => {
        const props = {
            id: 'c1',
            hash: 'hc',
            size: 5,
            mime: 'text/plain',
            storageKey: 'objects/c1',
            createdAt: new Date('2021-01-01T00:00:00.000Z'),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockImplementation(async (e: any) => e),
        } as any

        const stream = new Readable()
        stream.push('abc')
        stream.push(null)

        const storageMock = {
            getObjectStream: jest.fn().mockResolvedValue(stream),
        } as any

        const usecase = new GetBlobContentUseCase(repoMock, storageMock)

        const result = await usecase.execute(props.id)

        expect(repoMock.findById).toHaveBeenCalledWith(props.id)
        expect(repoMock.update).toHaveBeenCalled()
        expect(storageMock.getObjectStream).toHaveBeenCalledWith(props.storageKey)
        expect(result.info.id).toBe(props.id)
        expect(result.stream).toBe(stream)
    })

    it('throws NotFoundException when blob missing', async () => {
        const repoMock = { findById: jest.fn().mockResolvedValue(null) } as any
        const storageMock = { getObjectStream: jest.fn() } as any
        const usecase = new GetBlobContentUseCase(repoMock, storageMock)

        await expect(usecase.execute('x')).rejects.toThrow(NotFoundException)
    })
})
