import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)

    const config = new DocumentBuilder()
        .setTitle('Blob Storage Service')
        .setDescription('Standalone Blob Storage Service for internal use between services. All endpoints are protected by X-API-KEY header.')
        .setVersion('1.0.0')
        .addApiKey(
            {
                type: 'apiKey',
                name: 'X-API-KEY',
                in: 'header',
            },
            'apiKey',
        )
        .build()

    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('docs', app, document)

    await app.listen(process.env.PORT || 3100)
}

bootstrap()
