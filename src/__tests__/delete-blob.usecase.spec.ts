import { ConflictException, NotFoundException } from '@nestjs/common'
import { DeleteBlobUseCase } from '../application/use-cases/delete-blob.usecase'
import { BlobEntity } from '../domain/blob.entity'

const makeEntity = (id: string, generation = 2, deletedAt: Date | null = null) => new BlobEntity({
    id, hash: 'hash', size: 10, mime: 'image/png', storageKey: 'objects/shared',
    createdAt: new Date(), lastUsedAt: null, deletedAt, generation,
})

describe('DeleteBlobUseCase', () => {
    it('hard deletes only a v2 logical handle', async () => {
        const entity = makeEntity('v2')
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            hardDeleteLogical: jest.fn().mockResolvedValue(entity),
        } as any
        const dto = await new DeleteBlobUseCase(repo).execute(entity.id, true)
        expect(repo.hardDeleteLogical).toHaveBeenCalledWith(entity.id)
        expect(dto.id).toBe(entity.id)
    })

    it('soft deletes a v2 logical handle', async () => {
        const entity = makeEntity('v2')
        const deleted = makeEntity('v2', 2, new Date())
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            softDeleteLogical: jest.fn().mockResolvedValue(deleted),
        } as any
        const dto = await new DeleteBlobUseCase(repo).execute(entity.id, false)
        expect(repo.softDeleteLogical).toHaveBeenCalledWith(entity.id)
        expect(dto.deletedAt).not.toBeNull()
    })

    it('returns the prior deletion time on repeated soft delete', async () => {
        const deletedAt = new Date('2026-01-01T00:00:00Z')
        const entity = makeEntity('v2', 2, deletedAt)
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            softDeleteLogical: jest.fn().mockResolvedValue(entity),
        } as any
        const dto = await new DeleteBlobUseCase(repo).execute(entity.id, false)
        expect(dto.deletedAt).toBe(deletedAt.toISOString())
    })

    it.each([false, true])('rejects deleting a legacy ID (force=%s)', async (force) => {
        const entity = makeEntity('legacy', 1)
        const repo = {
            findById: jest.fn().mockResolvedValue(entity),
            softDeleteLogical: jest.fn(),
            hardDeleteLogical: jest.fn(),
        } as any
        await expect(new DeleteBlobUseCase(repo).execute(entity.id, force)).rejects.toThrow(ConflictException)
        expect(repo.softDeleteLogical).not.toHaveBeenCalled()
        expect(repo.hardDeleteLogical).not.toHaveBeenCalled()
    })

    it('returns 404 for a missing handle', async () => {
        const repo = { findById: jest.fn().mockResolvedValue(null) } as any
        await expect(new DeleteBlobUseCase(repo).execute('missing', false)).rejects.toThrow(NotFoundException)
    })
})
