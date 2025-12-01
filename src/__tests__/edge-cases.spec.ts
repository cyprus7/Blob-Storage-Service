import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { GetBlobInfoUseCase } from '../application/use-cases/get-blob-info.usecase'
import { GetBlobContentUseCase } from '../application/use-cases/get-blob-content.usecase'
import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

describe('Edge cases and malformed DTOs', () => {
    it('UploadBlobUseCase throws when repo.save returns null (malformed DTO)', async () => {
        const buffer = Buffer.from('x')
        const size = buffer.length
        const mimetype = 'text/plain'

        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/x'),
            putObject: jest.fn().mockResolvedValue(undefined),
        } as any

        const repoMock = {
            findByHashAndSize: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue(null),
        } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)
        const file = { buffer, size, mimetype, originalname: 'x.txt' } as Express.Multer.File

        await expect(usecase.execute(file)).rejects.toThrow()
        expect(storageMock.putObject).toHaveBeenCalled()
        expect(repoMock.save).toHaveBeenCalled()
    })

    it('UploadBlobUseCase propagates transient storage errors (no retry)', async () => {
        const buffer = Buffer.from('y')
        const size = buffer.length
        const mimetype = 'text/plain'

        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/y'),
            putObject: jest.fn()
                .mockRejectedValueOnce(new Error('transient put'))
                .mockResolvedValue(undefined),
        } as any

        const repoMock = { findByHashAndSize: jest.fn().mockResolvedValue(null) } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)
        const file = { buffer, size, mimetype, originalname: 'y.txt' } as Express.Multer.File

        // current implementation does not retry, so first rejection should propagate
        await expect(usecase.execute(file)).rejects.toThrow('transient put')
    })

    it('GetBlobInfoUseCase throws when repo.update returns null (malformed)', async () => {
        const props = {
            id: 'edge1',
            hash: 'he',
            size: 1,
            mime: 'text/plain',
            storageKey: 'objects/e1',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }
        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockResolvedValue(null),
        } as any

        const usecase = new GetBlobInfoUseCase(repoMock)

        await expect(usecase.execute(props.id)).rejects.toThrow()
    })

    it('GetBlobContentUseCase returns non-stream objects as-is if storage returns buffer', async () => {
        const props = {
            id: 'edge2',
            hash: 'hc',
            size: 2,
            mime: 'text/plain',
            storageKey: 'objects/e2',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }
        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            update: jest.fn().mockResolvedValue(entity),
        } as any

        const buf = Buffer.from('ok')
        const storageMock = { getObjectStream: jest.fn().mockResolvedValue(buf) } as any

        const usecase = new GetBlobContentUseCase(repoMock, storageMock)

        const res = await usecase.execute(props.id)
        expect(res.stream).toBe(buf)
    })

    it('DeleteBlobUseCase propagates repo.delete failures on hard delete', async () => {
        const props = {
            id: 'edge3',
            hash: 'hd',
            size: 3,
            mime: 'image/png',
            storageKey: 'objects/e3',
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }
        const entity = new BlobEntity({ ...props })

        const repoMock = {
            findById: jest.fn().mockResolvedValue(entity),
            delete: jest.fn().mockRejectedValue(new Error('repo delete failed')),
        } as any

        const storageMock = { deleteObject: jest.fn().mockResolvedValue(undefined) } as any

        const usecase = new DeleteBlobUseCase(repoMock, storageMock)

        await expect(usecase.execute(props.id, true)).rejects.toThrow('repo delete failed')
    })
})
