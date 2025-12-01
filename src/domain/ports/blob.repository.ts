import { BlobEntity, BlobProps } from '../blob.entity'

export abstract class BlobRepository {
    abstract findById(id: string): Promise<BlobEntity | null>;
    abstract findByHashAndSize(hash: string, size: number): Promise<BlobEntity | null>;
    abstract save(props: Omit<BlobProps, 'id' | 'createdAt' | 'lastUsedAt' | 'deletedAt'>): Promise<BlobEntity>;
    abstract update(blob: BlobEntity): Promise<BlobEntity>;
    abstract delete(id: string): Promise<void>;
}
