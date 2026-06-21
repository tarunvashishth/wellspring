// Magic byte signatures for supported media types
const SIGNATURES: Array<{ bytes: number[]; mask?: number[]; contentType: string }> = [
  // MP4 / MOV — ftyp box at offset 4
  { bytes: [0x66, 0x74, 0x79, 0x70], contentType: 'video/mp4' }, // ftyp
  // WebM
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], contentType: 'video/webm' },
  // MKV
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], contentType: 'video/x-matroska' },
  // MP3 (ID3 tag)
  { bytes: [0x49, 0x44, 0x33], contentType: 'audio/mpeg' },
  // MP3 (sync word)
  { bytes: [0xff, 0xfb], contentType: 'audio/mpeg' },
  { bytes: [0xff, 0xf3], contentType: 'audio/mpeg' },
  { bytes: [0xff, 0xf2], contentType: 'audio/mpeg' },
  // AAC
  { bytes: [0xff, 0xf1], contentType: 'audio/aac' },
  { bytes: [0xff, 0xf9], contentType: 'audio/aac' },
  // WAV
  { bytes: [0x52, 0x49, 0x46, 0x46], contentType: 'audio/wav' },
  // OGG
  { bytes: [0x4f, 0x67, 0x67, 0x53], contentType: 'audio/ogg' },
  // FLAC
  { bytes: [0x66, 0x4c, 0x61, 0x43], contentType: 'audio/flac' },
  // M4A / M4V — also ftyp
  { bytes: [0x66, 0x74, 0x79, 0x70], contentType: 'audio/mp4' },
];

const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
]);

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

export function validateMagicBytes(buffer: Buffer, declaredContentType: string): boolean {
  if (!isAllowedContentType(declaredContentType)) return false;

  // MP4/MOV: ftyp box starts at byte 4 (after 4-byte box size)
  const checkBuffer = buffer.length > 8 ? buffer.slice(4) : buffer;

  for (const sig of SIGNATURES) {
    const match = sig.bytes.every((byte, i) => buffer[i] === byte || checkBuffer[i] === byte);
    if (match) return true;
  }

  return false;
}
