export interface BlobInfo {
    id: string;
    hash: string;
    size: number;
    mime: string;
    storageKey: string;
    createdAt: string;
    lastUsedAt: string | null;
    deletedAt: string | null;
}
