import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { awsEnv } from './env.js';

const s3 = new S3Client({});

export async function putReceiptObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: awsEnv.receiptBucketName,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function getReceiptObjectBuffer(key: string) {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: awsEnv.receiptBucketName,
      Key: key,
    }),
  );

  const chunks: Buffer[] = [];
  const body = response.Body;
  if (!body) {
    throw new Error('S3 object body was empty.');
  }

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function createReceiptUploadUrl(input: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  const command = new PutObjectCommand({
    Bucket: awsEnv.receiptBucketName,
    Key: input.key,
    ContentType: input.contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: input.expiresInSeconds ?? 900,
  });

  return {
    bucket: awsEnv.receiptBucketName,
    key: input.key,
    uploadUrl,
    expiresInSeconds: input.expiresInSeconds ?? 900,
  };
}

export async function createReceiptDownloadUrl(input: {
  key: string;
  expiresInSeconds?: number;
}) {
  const command = new GetObjectCommand({
    Bucket: awsEnv.receiptBucketName,
    Key: input.key,
  });

  const downloadUrl = await getSignedUrl(s3, command, {
    expiresIn: input.expiresInSeconds ?? 900,
  });

  return {
    bucket: awsEnv.receiptBucketName,
    key: input.key,
    downloadUrl,
    expiresInSeconds: input.expiresInSeconds ?? 900,
  };
}

export async function putReceiptJsonObject(key: string, value: unknown) {
  await s3.send(
    new PutObjectCommand({
      Bucket: awsEnv.receiptBucketName,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
}

export async function getReceiptJsonObject<T>(key: string): Promise<T> {
  const buffer = await getReceiptObjectBuffer(key);
  return JSON.parse(buffer.toString('utf8')) as T;
}

export async function listReceiptJsonKeys(prefix: string, maxKeys: number) {
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: awsEnv.receiptBucketName,
      Prefix: prefix,
      MaxKeys: maxKeys,
    }),
  );

  return (response.Contents ?? [])
    .filter((item): item is NonNullable<typeof item> & { Key: string } => Boolean(item.Key))
    .sort((left, right) => {
      const leftTime = left.LastModified?.getTime() ?? 0;
      const rightTime = right.LastModified?.getTime() ?? 0;
      return rightTime - leftTime;
    })
    .map((item) => item.Key);
}
