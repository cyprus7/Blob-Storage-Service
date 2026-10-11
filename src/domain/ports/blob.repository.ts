import { BlobEntity } from '../blob.entity'

export interface PhysicalBlob {
    id: string;
    hash: string;
    size: number;
    mime: string;
    storageKey: string;
    status: 'pending' | 'active' | 'deleting';
    createdAt?: Date;
    updatedAt?: Date;
    unreferencedAt?: Date | null;
}

export abstract class BlobRepository {
    abstract findById(id: string): Promise<BlobEntity | null>;
    abstract prepareUpload(hash: string, size: number, mime: string, storageKey: string): Promise<{ object: PhysicalBlob; needsUpload: boolean }>;
    abstract createLogicalBlob(hash: string, size: number, mime: string, uploaded: boolean): Promise<BlobEntity>;
    abstract touchActive(id: string): Promise<BlobEntity | null>;
    abstract softDeleteLogical(id: string): Promise<BlobEntity | null>;
    abstract hardDeleteLogical(id: string): Promise<BlobEntity | null>;

    // Maintenance operations are opt-in and never run from the HTTP module.
    abstract listStalePending(cutoff: Date, limit: number): Promise<PhysicalBlob[]>;
    abstract recoverPending(id: string, hash: string): Promise<boolean>;
    abstract listUntrackedOrphans(limit: number): Promise<PhysicalBlob[]>;
    abstract markUnreferenced(id: string, hash: string): Promise<boolean>;
    abstract listEligibleForDeletion(cutoff: Date, limit: number): Promise<PhysicalBlob[]>;
    abstract claimDeletion(id: string, hash: string, cutoff: Date): Promise<PhysicalBlob | null>;
    abstract listDeleting(limit: number): Promise<PhysicalBlob[]>;
    abstract getSafeDeleting(id: string, hash: string): Promise<PhysicalBlob | null>;
    abstract finalizeDeletion(id: string, hash: string): Promise<boolean>;
}
