/**
 * S3 client with pooled keep-alive connections, used to archive backgrounds.
 */

const http = require('http');
const https = require('https');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  maxAttempts: 3,
  requestHandler: new (require('@aws-sdk/node-http-handler').NodeHttpHandler)({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  }),
});

module.exports = { s3Client, PutObjectCommand, GetObjectCommand };
