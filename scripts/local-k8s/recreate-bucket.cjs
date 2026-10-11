const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3')

const client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
})

client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }))
  .catch((error) => {
    if (error.name !== 'BucketAlreadyOwnedByYou') throw error
  })
