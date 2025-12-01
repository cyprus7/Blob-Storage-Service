import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'

@Injectable()
export class ApiKeyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest()
        const apiKeyHeader = request.headers['x-api-key'] as string | undefined
        const expected = process.env.BLOB_API_KEY

        if (!expected) {
            throw new Error('BLOB_API_KEY is not configured')
        }

        if (!apiKeyHeader || apiKeyHeader !== expected) {
            throw new UnauthorizedException('Invalid or missing X-API-KEY')
        }

        return true
    }
}
