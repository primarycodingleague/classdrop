/* Where media bytes live. `disk` for local work, `s3` for AWS S3 or any S3-compatible
   store. The rest of the server only sees put/get/remove, so switching provider is an
   environment variable, not a code change. */
import fs from 'node:fs/promises';
import path from 'node:path';

export function makeStorage(env = process.env) {
  const kind = env.STORAGE || 'disk';
  if (kind === 'disk') return diskStorage(env.STORAGE_DIR || './data/media');
  if (kind === 's3') return s3Storage(env);
  throw new Error(`unknown STORAGE "${kind}" — use disk or s3`);
}

function diskStorage(root) {
  const file = key => path.join(root, key.replace(/[^a-zA-Z0-9_/.-]/g, '_'));
  return {
    kind: 'disk',
    async put(key, bytes) {
      const f = file(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, bytes);
    },
    async get(key) {
      try { return await fs.readFile(file(key)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async remove(key) { await fs.rm(file(key), { force: true }); },
  };
}

function s3Storage(env) {
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is required when STORAGE=s3');
  let client = null;
  const sdk = async () => {
    if (client) return client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    client = {
      s3: new S3Client({
        region: env.S3_REGION || 'eu-west-2',
        endpoint: env.S3_ENDPOINT || undefined,      // set for R2 / MinIO, leave unset for AWS
        forcePathStyle: !!env.S3_ENDPOINT,
      }),
      cmds: await import('@aws-sdk/client-s3'),
    };
    return client;
  };
  return {
    kind: 's3',
    async put(key, bytes, mime) {
      const { s3, cmds } = await sdk();
      await s3.send(new cmds.PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
    },
    async get(key) {
      const { s3, cmds } = await sdk();
      try {
        const r = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) { if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null; throw e; }
    },
    async remove(key) {
      const { s3, cmds } = await sdk();
      await s3.send(new cmds.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
