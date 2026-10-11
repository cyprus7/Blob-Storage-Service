import { UploadBlobUseCase } from '../application/use-cases/upload-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

describe('UploadBlobUseCase (negative cases)', () => {
    it('propagates error when storage.putObject fails', async () => {
        const buffer = Buffer.from('bad')
        const size = buffer.length
        const mimetype = 'text/plain'

        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/bad'),
            putObject: jest.fn().mockRejectedValue(new Error('put failed')),
        } as any

        const repoMock = {
            prepareUpload: jest.fn().mockResolvedValue({ object: { storageKey: 'objects/bad', mime: mimetype }, needsUpload: true }),
            createLogicalBlob: jest.fn(),
        } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)

        const file = { buffer, size, mimetype, originalname: 'bad.txt' } as Express.Multer.File

        await expect(usecase.execute(file)).rejects.toThrow('put failed')
        expect(storageMock.putObject).toHaveBeenCalled()
        expect(repoMock.createLogicalBlob).not.toHaveBeenCalled()
    })

    it('propagates error when repo.save fails after putObject', async () => {
        const buffer = Buffer.from('bad2')
        const size = buffer.length
        const mimetype = 'text/plain'

        const storageMock = {
            buildKeyFromHash: jest.fn().mockReturnValue('objects/bad2'),
            putObject: jest.fn().mockResolvedValue(undefined),
        } as any

        const repoMock = {
            prepareUpload: jest.fn().mockResolvedValue({ object: { storageKey: 'objects/bad2', mime: mimetype }, needsUpload: true }),
            createLogicalBlob: jest.fn().mockRejectedValue(new Error('save failed')),
        } as any

        const usecase = new UploadBlobUseCase(storageMock, repoMock)
        const file = { buffer, size, mimetype, originalname: 'bad2.txt' } as Express.Multer.File

        await expect(usecase.execute(file)).rejects.toThrow('save failed')
        expect(storageMock.putObject).toHaveBeenCalled()
        expect(repoMock.createLogicalBlob).toHaveBeenCalled()
    })
})
