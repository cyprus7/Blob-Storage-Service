export interface BlobProps {
    id: string;
    hash: string;
    size: number;
    mime: string;
    storageKey: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    deletedAt: Date | null;
    generation?: number;
    objectId?: string | null;
}

export class BlobEntity {
    constructor(public props: BlobProps) {}

    get id() { return this.props.id }
    get hash() { return this.props.hash }
    get size() { return this.props.size }
    get mime() { return this.props.mime }
    get storageKey() { return this.props.storageKey }
    get createdAt() { return this.props.createdAt }
    get lastUsedAt() { return this.props.lastUsedAt }
    get deletedAt() { return this.props.deletedAt }
    get generation() { return this.props.generation ?? 1 }
    get objectId() { return this.props.objectId ?? null }

    markUsed(now: Date = new Date()) {
        this.props.lastUsedAt = now
    }

    softDelete(now: Date = new Date()) {
        this.props.deletedAt = now
    }

    isDeleted(): boolean {
        return !!this.props.deletedAt
    }
}
