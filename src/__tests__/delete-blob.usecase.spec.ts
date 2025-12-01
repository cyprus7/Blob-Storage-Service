import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'
import { NotFoundException } from '@nestjs/common'

describe('DeleteBlobUseCase', () => {
    it('hard deletes when force=true', async () => {
        const props = {
            id: 'd1',
            hash: 'hd',
            size: 10,
            mime: 'image/jpeg',
            storageKey: 'objects/d1',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            delete: jest.fn().mockResolvedValue(undefined),
        } as any

        const storageMock = { deleteObject: jest.fn().mockResolvedValue(undefined) } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        const dto = await usecase.execute(props.id, true)

        expect(repoMock.findById).toHaveBeenCalledWith(props.id)
        expect(storageMock.deleteObject).toHaveBeenCalledWith(props.storageKey)
        expect(repoMock.delete).toHaveBeenCalledWith(props.id)
        expect(dto.id).toBe(props.id)
    })

    it('soft deletes when not force and not deleted', async () => {
        const props = {
            id: 'd2',
            hash: 'hd2',
            size: 11,
            mime: 'text/plain',
            storageKey: 'objects/d2',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const entity = new BlobEntity({ ...props })

        const updated = new BlobEntity({ ...props, deletedAt: new Date() })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockResolvedValue(updated),
        } as any

        const storageMock = { deleteObject: jest.fn() } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        const dto = await usecase.execute(props.id, false)

        expect(repoMock.findById).toHaveBeenCalledWith(props.id)
        expect(repoMock.update).toHaveBeenCalled()
        expect(storageMock.deleteObject).not.toHaveBeenCalled()
        expect(dto.deletedAt).not.toBeNull()
    })

    it('returns entity when already soft-deleted', async () => {
        const props = {
            id: 'd3',
            hash: 'hd3',
            size: 12,
            mime: 'text/plain',
            storageKey: 'objects/d3',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: new Date(),
        }

        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn(),
        } as any

        const storageMock = { deleteObject: jest.fn() } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        const dto = await usecase.execute(props.id, false)

        expect(repoMock.findById).toHaveBeenCalledWith(props.id)
        expect(repoMock.update).not.toHaveBeenCalled()
        expect(storageMock.deleteObject).not.toHaveBeenCalled()
        expect(dto.deletedAt).not.toBeNull()
    })

    it('throws NotFoundException when missing', async () => {
        const repoMock = { findById: jest.fn().mockResolvedValue(null) } as any
        const storageMock = { deleteObject: jest.fn() } as any
        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        await expect(usecase.execute('nope', false)).rejects.toThrow(NotFoundException)
    })
})
