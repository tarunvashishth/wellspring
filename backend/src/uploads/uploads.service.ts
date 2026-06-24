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

// S3 client — works with real AWS S3 or a local MinIO instance (used in dev/docker).
// forcePathStyle is needed for MinIO which doesn't support virtual-hosted-style bucket URLs.
const s3 = new S3Client({
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
  ...(config.AWS_ENDPOINT && { endpoint: config.AWS_ENDPOINT, forcePathStyle: true }),
});

// Constructs a unique S3 key path for an upload.
// Format: uploads/<creatorId>/<sessionId>/<uuid>.<ext>
// Namespacing by creatorId/sessionId makes it easy to find or delete all files for a user or session.
// randomUUID() ensures two uploads with the same filename don't overwrite each other.
function buildUploadKey(creatorId: string, sessionId: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin';
  return `uploads/${creatorId}/${sessionId}/${randomUUID()}.${ext}`;
}

// Step 1 of the upload flow: generates a pre-signed POST URL.
//
// Why pre-signed POST instead of uploading through our server?
//   The browser uploads the file DIRECTLY to S3 — our server never handles the raw bytes.
//   This avoids large memory/bandwidth overhead on the API server for video files.
//
// The pre-signed URL is a time-limited token (Expires seconds) that allows exactly one
// upload to a specific S3 key, with enforced conditions (file size limit, content type,
// required metadata). S3 rejects any upload that violates those conditions.
export async function initiateUpload(sessionId: string, contentType: string, filename: string) {
  const { tenantId } = getContext();

  // Allowlist check — only permit known media content types (video/mp4 etc.), not arbitrary files.
  if (!isAllowedContentType(contentType)) {
    throw new AppError(`Content type ${contentType} is not allowed`, 422);
  }

  return withTenant(async (tx) => {
    // Verify the session exists and belongs to this user (RLS enforces ownership).
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('Session not found', 404);

    const uploadKey = buildUploadKey(tenantId, sessionId, filename);

    // createPresignedPost returns { url, fields } — the browser POSTs to `url` with
    // all `fields` as form fields plus the actual file.
    // Conditions act as server-side constraints that S3 enforces:
    //   - content-length-range: rejects files that are too large or empty
    //   - eq $Content-Type: ensures browser can't switch to a different file type
    //   - x-amz-server-side-encryption: forces AES-256 at-rest encryption
    //   - x-amz-meta-*: custom metadata we'll verify in completeUpload
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

    // Mark the session as PROCESSING immediately so the UI can show upload progress.
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

// Step 2 of the upload flow: called by the browser AFTER the direct S3 upload completes.
// Verifies the file actually landed in S3, checks metadata integrity, validates file contents
// via magic bytes, then marks the session as VERIFIED.
//
// Multi-layer security here:
//  1. Key prefix check — prevents one user from completing an upload for another user's key
//  2. Session.mediaKey check — prevents replaying an old upload key for a different session
//  3. S3 metadata check — confirms the stored metadata matches what we expected
//  4. Magic bytes check — reads the first 16 bytes of the file to confirm it's actually
//     the declared media type (e.g. confirms a file claiming to be video/mp4 has an MP4 header)
//     This prevents content-type spoofing (e.g. uploading an executable named video.mp4).
export async function completeUpload(sessionId: string, uploadKey: string) {
  const { tenantId } = getContext();

  return withTenant(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('Session not found', 404);

    // Security: confirm the upload key belongs to this tenant — prevents cross-user key reuse.
    if (!uploadKey.startsWith(`uploads/${tenantId}/`)) {
      throw new AppError('Upload key does not match tenant', 403);
    }
    // Confirm the key matches what initiateUpload recorded for this session.
    if (session.mediaKey !== uploadKey) {
      throw new AppError('Upload key does not match session', 400);
    }

    // Verify the object exists and metadata is intact
    let head: Awaited<ReturnType<typeof s3.send>>;
    try {
      // HeadObject fetches file metadata without downloading the file content — fast and cheap.
      head = await s3.send(
        new HeadObjectCommand({ Bucket: config.AWS_BUCKET, Key: uploadKey }),
      );
    } catch {
      throw new AppError('Upload not found in storage', 422);
    }

    // Double-check the metadata we embedded at initiation time hasn't been tampered with.
    const meta = (head as { Metadata?: Record<string, string> }).Metadata ?? {};
    if (meta['creator-id'] !== tenantId || meta['session-id'] !== sessionId) {
      await safeDeleteObject(uploadKey);
      throw new AppError('Upload metadata mismatch', 422);
    }

    // Inline magic-byte verification — fetch first 16 bytes from S3
    // This ensures we never set VERIFIED on non-media content
    let magicValid = false;
    try {
      // Range: bytes=0-15 fetches only the first 16 bytes — the file "magic bytes" / file header.
      // Every file format has a known signature in its first few bytes (e.g. MP4 starts with ftyp).
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
      // Delete the bad file from S3 immediately, mark session FAILED, and log a warning.
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

    // All checks passed — create the Media record and mark session as VERIFIED.
    // sizeBytes is stored as BigInt because video files can exceed JavaScript's safe integer limit.
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

// Best-effort S3 cleanup — swallows errors because we never want a failed S3 delete
// to prevent the error response from reaching the client.
async function safeDeleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.AWS_BUCKET, Key: key }));
  } catch {
    // Best-effort cleanup
  }
}
