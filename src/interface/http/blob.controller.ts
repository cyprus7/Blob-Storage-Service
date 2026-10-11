import {
    Controller,
    Post,
    Get,
    Delete,
    Param,
    Query,
    UploadedFile,
    UseInterceptors,
    UseGuards,
    Res,
    BadRequestException,
    Logger,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Response } from 'express'
import { Readable } from 'stream'
import {
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiSecurity,
    ApiTags,
} from '@nestjs/swagger'
import { UploadBlobUseCase } from '../../application/use-cases/upload-blob.usecase'
import { GetBlobInfoUseCase } from '../../application/use-cases/get-blob-info.usecase'
import { GetBlobContentUseCase } from '../../application/use-cases/get-blob-content.usecase'
import { DeleteBlobUseCase } from '../../application/use-cases/delete-blob.usecase'
import { ApiKeyGuard } from './api-key.guard'
import { BlobInfoResponseDto } from './dto/blob-info.response.dto'
import { UploadCapacityGuard } from './upload-capacity.guard'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

@ApiTags('Blobs')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/blobs')
export class BlobController {
    private readonly logger = new Logger(BlobController.name)

    constructor(
        private readonly uploadBlob: UploadBlobUseCase,
        private readonly getBlobInfo: GetBlobInfoUseCase,
        private readonly getBlobContent: GetBlobContentUseCase,
        private readonly deleteBlob: DeleteBlobUseCase,
    ) { }

    @Post()
    @UseGuards(UploadCapacityGuard)
    @UseInterceptors(FileInterceptor('file', {
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
    }))
    @ApiOperation({ summary: 'Upload a new blob with SHA-256 deduplication' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: { type: 'string', format: 'binary' },
            },
            required: ['file'],
        },
    })
    @ApiResponse({ status: 201, type: BlobInfoResponseDto })
    async upload(@UploadedFile() file: Express.Multer.File): Promise<BlobInfoResponseDto> {
        if (!file) throw new BadRequestException('file is required')
        const result = await this.uploadBlob.execute(file)
        return result.info as BlobInfoResponseDto
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get blob metadata by id' })
    @ApiParam({ name: 'id', type: 'string' })
    @ApiResponse({ status: 200, type: BlobInfoResponseDto })
    async getInfo(@Param('id') id: string): Promise<BlobInfoResponseDto> {
        const info = await this.getBlobInfo.execute(id)
        return info as BlobInfoResponseDto
    }

    @Get(':id/content')
    @ApiOperation({ summary: 'Stream blob content by id' })
    @ApiParam({ name: 'id', type: 'string' })
    async getContent(@Param('id') id: string, @Res() res: Response) {
        const { info, stream } = await this.getBlobContent.execute(id)
        res.setHeader('Content-Type', info.mime)
        res.setHeader('Content-Disposition', `attachment; filename="${info.id}"`)
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Security-Policy', 'sandbox')
        res.setHeader('Cache-Control', 'private, no-store')
        await this.pipeContent(stream, res)
    }

    private pipeContent(stream: Readable, res: Response): Promise<void> {
        return new Promise((resolve) => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                resolve()
            }
            stream.once('error', (error: Error) => {
                this.logger.error(`Blob content stream failed: ${error.message}`)
                stream.unpipe(res)
                stream.destroy()
                if (res.headersSent) {
                    res.destroy(error)
                } else {
                    res.status(502).end()
                }
                finish()
            })
            res.once('error', () => {
                stream.destroy()
                finish()
            })
            res.once('close', () => {
                stream.destroy()
                finish()
            })
            res.once('finish', finish)
            stream.pipe(res)
        })
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Soft delete or hard delete a blob' })
    @ApiParam({ name: 'id', type: 'string' })
    @ApiQuery({
        name: 'force',
        required: false,
        type: Boolean,
        description: 'If true, delete the v2 logical handle from DB. S3 cleanup runs separately; legacy IDs cannot be deleted.',
    })
    @ApiResponse({ status: 200, type: BlobInfoResponseDto })
    async delete(
        @Param('id') id: string,
            @Query('force') force?: string,
    ): Promise<BlobInfoResponseDto> {
        const hard = String(force).toLowerCase() === 'true'
        const info = await this.deleteBlob.execute(id, hard)
        return info as BlobInfoResponseDto
    }
}
