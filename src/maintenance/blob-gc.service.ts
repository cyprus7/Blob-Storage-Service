import { createHash } from 'crypto'
import { BlobRepository, PhysicalBlob } from '../domain/ports/blob.repository'
import { BlobStoragePort } from '../domain/ports/blob-storage.port'

export interface BlobGcOptions {
    execute?: boolean;
    graceHours?: number;
    limit?: number;
    now?: Date;
}

export interface BlobGcSummary {
    mode: 'dry-run' | 'execute';
    cutoff: string;
    stalePending: number;
    recoveredPending: number;
    untrackedOrphans: number;
    markedUnreferenced: number;
    retryingDeletion: number;
    eligibleForDeletion: number;
    deleted: number;
    skipped: number;
    errors: Array<{ id: string; operation: string; message: string }>;
}

/** Internal maintenance implementation: run only through the exclusive CLI. */
export class BlobGcService {
    constructor(
        private readonly repository: BlobRepository,
        private readonly storage: BlobStoragePort,
    ) { }

    async run(options: BlobGcOptions = {}): Promise<BlobGcSummary> {
        const execute = options.execute ?? false
        const graceHours = options.graceHours ?? 24
        const limit = options.limit ?? 100
        if (!Number.isFinite(graceHours) || graceHours < 24) throw new Error('graceHours must be at least 24')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000')

        const cutoff = new Date((options.now ?? new Date()).getTime() - graceHours * 60 * 60 * 1000)
        const [pending, orphans, deleting, eligible] = await Promise.all([
            this.repository.listStalePending(cutoff, limit),
            this.repository.listUntrackedOrphans(limit),
            this.repository.listDeleting(limit),
            this.repository.listEligibleForDeletion(cutoff, limit),
        ])
        const summary: BlobGcSummary = {
            mode: execute ? 'execute' : 'dry-run',
            cutoff: cutoff.toISOString(),
            stalePending: pending.length,
            recoveredPending: 0,
            untrackedOrphans: orphans.length,
            markedUnreferenced: 0,
            retryingDeletion: deleting.length,
            eligibleForDeletion: eligible.length,
            deleted: 0,
            skipped: 0,
            errors: [],
        }
        if (!execute) return summary

        // A successful PUT followed by a DB failure leaves a pending row. A
        // full byte/hash check lets this run promote it without trusting HEAD.
        for (const object of pending) {
            try {
                if (!this.isV2Key(object)) { summary.skipped++; continue }
                if (!(await this.verifyPending(object))) { summary.skipped++; continue }
                if (await this.repository.recoverPending(object.id, object.hash)) summary.recoveredPending++
                else summary.skipped++
            } catch (error) {
                this.addError(summary, object.id, 'recoverPending', error)
            }
        }

        // Historical v2 objects may predate unreferenced_at. Begin their
        // grace period now; never infer it from last-used timestamps.
        for (const object of orphans) {
            try {
                if (!this.isV2Key(object)) { summary.skipped++; continue }
                if (await this.repository.markUnreferenced(object.id, object.hash)) summary.markedUnreferenced++
                else summary.skipped++
            } catch (error) {
                this.addError(summary, object.id, 'markUnreferenced', error)
            }
        }

        // Retry rows claimed by an earlier run, including a crash after S3
        // deletion but before the final DB delete. S3 DELETE is idempotent.
        for (const object of deleting) await this.deleteClaimed(object, summary)

        for (const object of eligible) {
            try {
                if (!this.isV2Key(object)) { summary.skipped++; continue }
                const claimed = await this.repository.claimDeletion(object.id, object.hash, cutoff)
                if (!claimed) { summary.skipped++; continue }
                await this.deleteClaimed(claimed, summary)
            } catch (error) {
                this.addError(summary, object.id, 'claimDeletion', error)
            }
        }

        return summary
    }

    private async deleteClaimed(object: PhysicalBlob, summary: BlobGcSummary): Promise<void> {
        try {
            // The key namespace is an independent guard: an old v1 key must
            // never be passed to S3 DELETE even if DB references are absent.
            if (!this.isV2Key(object)) { summary.skipped++; return }
            const safe = await this.repository.getSafeDeleting(object.id, object.hash)
            if (!safe) { summary.skipped++; return }
            await this.storage.deleteObject(safe.storageKey)
            if (await this.repository.finalizeDeletion(safe.id, safe.hash)) summary.deleted++
            else this.addError(summary, safe.id, 'finalizeDeletion', new Error('Object changed after S3 deletion'))
        } catch (error) {
            this.addError(summary, object.id, 'deleteObject', error)
        }
    }

    private isV2Key(object: PhysicalBlob): boolean {
        return /^[a-f0-9]{64}$/.test(object.hash)
            && object.storageKey === `objects/sha256/v2/${object.hash.slice(0, 2)}/${object.hash}`
    }

    private async verifyPending(object: PhysicalBlob): Promise<boolean> {
        const stream = await this.storage.getObjectStream(object.storageKey)
        const digest = createHash('sha256')
        let size = 0
        try {
            for await (const chunk of stream) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
                size += bytes.length
                if (size > object.size) return false
                digest.update(bytes)
            }
        } finally {
            stream.destroy()
        }
        return size === object.size && digest.digest('hex') === object.hash
    }

    private addError(summary: BlobGcSummary, id: string, operation: string, error: unknown): void {
        summary.errors.push({
            id,
            operation,
            message: error instanceof Error ? error.message : String(error),
        })
    }
}
