import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'crypto';
import { withTenant } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, rethrowMapped } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';
import { isAllowedContentType, validateMagicBytes } from './lib/magic-bytes';

const s3 = new S3Client({
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
  ...(config.AWS_ENDPOINT && { endpoint: config.AWS_ENDPOINT, forcePathStyle: true }),
});

function buildUploadKey(creatorId: string, sessionId: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin';
  return `uploads/${creatorId}/${sessionId}/${randomUUID()}.${ext}`;
}

export async function initiateUpload(sessionId: string, contentType: string, filename: string) {
  const { tenantId } = getContext();

  if (!isAllowedContentType(contentType)) {
    throw new AppError(`Content type ${contentType} is not allowed`, 422);
  }

  return withTenant(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('Session not found', 404);

    const uploadKey = buildUploadKey(tenantId, sessionId, filename);

    const { url, fields } = await createPresignedPost(s3, {
      Bucket: config.AWS_BUCKET,
      Key: uploadKey,
      Conditions: [
        ['content-length-range', 1, config.UPLOAD_MAX_BYTES],
        ['eq', '$Content-Type', contentType],
        ['eq', '$x-amz-server-side-encryption', 'AES256'],
        ['eq', '$x-amz-meta-creator-id', tenantId],
        ['eq', '$x-amz-meta-session-id', sessionId],
      ],
      Fields: {
        'Content-Type': contentType,
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-meta-creator-id': tenantId,
        'x-amz-meta-session-id': sessionId,
      },
      Expires: config.UPLOAD_EXPIRY_SECONDS,
    });

    await tx.session.update({
      where: { id: sessionId },
      data: { mediaKey: uploadKey, mediaStatus: 'PROCESSING' },
    });

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'upload.initiate',
      targetType: 'session',
      targetId: sessionId,
      metadata: { uploadKey, contentType },
    });

    return { uploadUrl: url, fields, uploadKey };
  });
}

export async function completeUpload(sessionId: string, uploadKey: string) {
  const { tenantId } = getContext();

  return withTenant(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('Session not found', 404);

    if (!uploadKey.startsWith(`uploads/${tenantId}/`)) {
      throw new AppError('Upload key does not match tenant', 403);
    }
    if (session.mediaKey !== uploadKey) {
      throw new AppError('Upload key does not match session', 400);
    }

    // Verify the object exists and metadata is intact
    let head: Awaited<ReturnType<typeof s3.send>>;
    try {
      head = await s3.send(
        new HeadObjectCommand({ Bucket: config.AWS_BUCKET, Key: uploadKey }),
      );
    } catch {
      throw new AppError('Upload not found in storage', 422);
    }

    const meta = (head as { Metadata?: Record<string, string> }).Metadata ?? {};
    if (meta['creator-id'] !== tenantId || meta['session-id'] !== sessionId) {
      await safeDeleteObject(uploadKey);
      throw new AppError('Upload metadata mismatch', 422);
    }

    // Inline magic-byte verification — fetch first 16 bytes from S3
    // This ensures we never set VERIFIED on non-media content
    let magicValid = false;
    try {
      const rangeResp = await s3.send(
        new GetObjectCommand({
          Bucket: config.AWS_BUCKET,
          Key: uploadKey,
          Range: 'bytes=0-15',
        }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of rangeResp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const header = Buffer.concat(chunks);
      const contentType = session.mediaKey
        ? ((head as { ContentType?: string }).ContentType ?? '')
        : '';
      magicValid = validateMagicBytes(header, contentType);
    } catch {
      // If we can't read the bytes, fail safe
      magicValid = false;
    }

    if (!magicValid) {
      await safeDeleteObject(uploadKey);
      await tx.session.update({ where: { id: sessionId }, data: { mediaStatus: 'FAILED' } });
      await writeAudit({
        tx,
        creatorId: tenantId,
        actorId: tenantId,
        action: 'upload.fail',
        targetType: 'session',
        targetId: sessionId,
        metadata: { uploadKey, reason: 'magic_byte_mismatch' },
        severity: 'warn',
      });
      throw new AppError('File content does not match declared content type', 422);
    }

    const sizeBytes = (head as { ContentLength?: number }).ContentLength;

    await tx.media
      .create({
        data: {
          sessionId,
          creatorId: tenantId,
          s3Key: uploadKey,
          contentType: (head as { ContentType?: string }).ContentType ?? '',
          sizeBytes: sizeBytes ? BigInt(sizeBytes) : null,
          status: 'VERIFIED',
        },
      })
      .catch(rethrowMapped);

    await tx.session.update({
      where: { id: sessionId },
      data: { mediaStatus: 'VERIFIED' },
    });

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'upload.complete',
      targetType: 'session',
      targetId: sessionId,
      metadata: { uploadKey, sizeBytes },
    });

    return { sessionId, mediaStatus: 'VERIFIED' as const };
  });
}

async function safeDeleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.AWS_BUCKET, Key: key }));
  } catch {
    // Best-effort cleanup
  }
}
