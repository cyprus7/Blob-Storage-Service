import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common'

/** Bounds simultaneous in-memory Multer uploads before the interceptor starts buffering. */
@Injectable()
export class UploadCapacityGuard implements CanActivate {
    private active = 0
    private readonly limit = UploadCapacityGuard.readLimit()

    canActivate(context: ExecutionContext): boolean {
        if (this.active >= this.limit) {
            throw new ServiceUnavailableException('Too many uploads in progress')
        }

        this.active += 1
        const response = context.switchToHttp().getResponse()
        let released = false
        const release = () => {
            if (released) return
            released = true
            this.active -= 1
        }
        response.once('finish', release)
        response.once('close', release)
        return true
    }

    private static readLimit(): number {
        const configured = Number(process.env.BLOB_MAX_CONCURRENT_UPLOADS ?? '4')
        if (!Number.isSafeInteger(configured) || configured < 1 || configured > 100) {
            throw new Error('BLOB_MAX_CONCURRENT_UPLOADS must be an integer between 1 and 100')
        }
        return configured
    }
}
