import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { log, type Config } from '../config.js';

/**
 * Upload rendered media to Cloudflare R2 (S3-compatible). Buffer fetches the video from the public URL,
 * so the bucket must be served publicly (custom domain or r2.dev) via R2_PUBLIC_BASE_URL.
 * Without R2 credentials the file is copied to work/out/ and a file:// URL is returned (dev only).
 */
export async function uploadPublic(cfg: Config, file: string, key: string, contentType: string): Promise<{ key: string; url: string; uploaded: boolean }> {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl } = cfg.r2;
  if (!accountId || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
    const outDir = path.join(cfg.workDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, key.replace(/\//g, '_'));
    fs.copyFileSync(file, dest);
    log.warn(`R2 not configured; kept ${dest} locally (Buffer needs a public URL, so publishing is disabled)`);
    return { key, url: `file://${dest}`, uploaded: false };
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(file), ContentType: contentType, ContentLength: fs.statSync(file).size, CacheControl: 'public, max-age=31536000, immutable' }));
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const url = `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
  log.info(`uploaded ${key} -> ${url}`);
  return { key, url, uploaded: true };
}
