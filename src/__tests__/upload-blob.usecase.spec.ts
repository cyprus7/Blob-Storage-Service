import { createHash } from 'crypto'
import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

describe('UploadBlobUseCase', () => {
    it('uploads new file when not deduplicated', async () => {
        const buffer = Buffer.from('hello world')
        const size = buffer.length
        const mimetype = 'text/plain'

        const hash = createHash('sha256').update(buffer).digest('hex')

        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue(`objects/sha256/${hash}`),
            putObject: jest.fn().mockResolvedValue(undefined),
        } as any

        const createdProps = {
            id: '1',
            hash,
            size,
            mime: mimetype,
            storageKey: `objects/sha256/${hash}`,
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const repoMock = {
            findByHashAndSize: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue(new BlobEntity(createdProps)),
            update: jest.fn(),
        } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)

        const file = {
            buffer,
            size,
            mimetype,
            originalname: 'hello.txt',
        } as Express.Multer.File

        const result = await usecase.execute(file)

        expect(storageMock.buildKeyFromHash).toHaveBeenCalledWith(hash, mimetype)
        expect(storageMock.putObject).toHaveBeenCalledWith({ key: createdProps.storageKey, body: buffer, mime: mimetype })
        expect(repoMock.save).toHaveBeenCalledWith({ hash, size, mime: mimetype, storageKey: createdProps.storageKey })

        expect(result.deduplicated).toBe(false)
        expect(result.info.id).toBe(createdProps.id)
        expect(result.info.hash).toBe(hash)
        expect(result.info.size).toBe(size)
    })
})
