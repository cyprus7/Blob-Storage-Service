import { createHash } from 'crypto'
import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

describe('UploadBlobUseCase', () => {
    it('creates a logical handle for a new physical object', async () => {
        const buffer = Buffer.from('hello world')
        const size = buffer.length
        const mimetype = 'text/plain'

        const hash = createHash('sha256').update(buffer).digest('hex')

        const storageKey = `objects/sha256/${hash.slice(0, 2)}/${hash}`
        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue(storageKey),
            putObject: jest.fn().mockResolvedValue(undefined),
        } as any

        const createdProps = {
            id: '1',
            hash,
            size,
            mime: mimetype,
            storageKey,
            createdAt: new Date(),
            lastUsedAt: null,
            deletedAt: null,
        }

        const repoMock = {
            prepareUpload: jest.fn().mockResolvedValue({
                object: { id: 'object-1', hash, size, mime: mimetype, storageKey, status: 'pending' },
                needsUpload: true,
            }),
            createLogicalBlob: jest.fn().mockResolvedValue(new BlobEntity({ ...createdProps, generation: 2 })),
        } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)

        const file = {
            buffer,
            size,
            mimetype,
            originalname: 'hello.txt',
        } as Express.Multer.File

        const result = await usecase.execute(file)

        expect(repoMock.prepareUpload).toHaveBeenCalledWith(hash, size, mimetype, storageKey)
        expect(storageMock.buildKeyFromHash).toHaveBeenCalledWith(hash, mimetype)
        expect(storageMock.putObject).toHaveBeenCalledWith({ key: storageKey, body: buffer, mime: mimetype })
        expect(repoMock.createLogicalBlob).toHaveBeenCalledWith(hash, size, mimetype, true)

        expect(result.deduplicated).toBe(false)
        expect(result.info.id).toBe(createdProps.id)
        expect(result.info.hash).toBe(hash)
        expect(result.info.size).toBe(size)
    })
})
