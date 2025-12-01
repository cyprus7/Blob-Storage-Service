import { ApiProperty } from '@nestjs/swagger'

export class BlobInfoResponseDto {
    @ApiProperty()
        id!: string

    @ApiProperty()
        hash!: string

    @ApiProperty()
        size!: number

    @ApiProperty()
        mime!: string

    @ApiProperty()
        storageKey!: string

    @ApiProperty()
        createdAt!: string

    @ApiProperty({ nullable: true })
        lastUsedAt!: string | null

    @ApiProperty({ nullable: true })
        deletedAt!: string | null
}
