import { Readable } from 'stream'

export abstract class BlobStoragePort {
    abstract buildKeyFromHash(hash: string, mime: string): string;

    abstract putObject(params: {
        key: string;
        body: Buffer | Readable;
        mime: string;
    }): Promise<void>;

    abstract getObjectStream(key: string): Promise<Readable>;

    abstract deleteObject(key: string): Promise<void>;
}
