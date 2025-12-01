import { Injectable } from '@nestjs/common'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { BlobStoragePort } from '../../domain/ports/blob-storage.port'
import { Readable } from 'stream'

@Injectable()
export class S3BlobStorageAdapter extends BlobStoragePort {
    private readonly s3: S3Client
    private readonly bucket: string

    constructor() {
        super()
        const endpoint = process.env.S3_ENDPOINT
        const region = process.env.S3_REGION || 'us-east-1'
        this.bucket = process.env.S3_BUCKET || 'blobs'
        const accessKeyId = process.env.S3_ACCESS_KEY || process.env.MINIO_ROOT_USER
        const secretAccessKey = process.env.S3_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD

        this.s3 = new S3Client({
            region,
            endpoint,
            forcePathStyle: true,
            credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
        })
    }

    buildKeyFromHash(hash: string, mime: string): string {
        const prefix = 'objects/sha256'
        const subdir = hash.slice(0, 2)
        let ext = ''
        if (mime) {
            const parts = mime.split('/')
            if (parts[1]) {
                ext = '.' + parts[1]
            }
        }
        return `${prefix}/${subdir}/${hash}${ext}`
    }

    async putObject(params: { key: string; body: Buffer | Readable; mime: string }): Promise<void> {
        await this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: params.key,
            Body: params.body,
            ContentType: params.mime,
        }))
    }

    async getObjectStream(key: string): Promise<Readable> {
        const result = await this.s3.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }))

        const body = result.Body
        if (!body) {
            throw new Error('S3 object body is empty')
        }

        // If it's already a Node Readable, return it
        if (body instanceof Readable) {
            return body
        }

        // If it looks like a Node stream (has pipe), treat as NodeJS.ReadableStream
        const maybeNodeStream = body as unknown as { pipe?: (...args: unknown[]) => unknown }
        if (typeof maybeNodeStream.pipe === 'function') {
            return body as unknown as Readable
        }

        // If it's a Web ReadableStream (browser-like), convert to Node Readable (Node 18+)
        const maybeReadableStreamLike = body as unknown as { getReader?: unknown }
        const readableFromWeb = (Readable as unknown as { fromWeb?: (s: unknown) => Readable }).fromWeb
        if (typeof maybeReadableStreamLike.getReader === 'function' && typeof readableFromWeb === 'function') {
            // fromWeb returns a Node Readable
            return readableFromWeb(body as unknown)
        }

        // If body is a Buffer / Uint8Array / string, create a Readable from it
        const maybeBuffer = body as unknown
        if (Buffer.isBuffer(maybeBuffer as Buffer) || maybeBuffer instanceof Uint8Array || typeof maybeBuffer === 'string') {
            return Readable.from([maybeBuffer as Buffer | Uint8Array | string])
        }

        // Fallback: wrap unknown into a Readable
        const fallback = new Readable()
        // push accepts unknown when coerced; convert to string as last resort
        fallback.push(typeof maybeBuffer === 'string' ? maybeBuffer : JSON.stringify(maybeBuffer))
        fallback.push(null)
        return fallback
    }

    async deleteObject(key: string): Promise<void> {
        await this.s3.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }))
    }
}
