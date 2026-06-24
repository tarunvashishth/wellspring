import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '../db/prisma';
import { config } from '../config';
import { AppError } from '../lib/errors';
import { denylistToken, isTokenDenylisted } from '../lib/redis';
import { writeSecurityAudit } from '../lib/audit';

// Shape of the data encoded inside a JWT token.
// sub = subject (the creator's ID), jti = unique token ID (used for logout denylist),
// iat = issued-at timestamp, exp = expiry timestamp.
interface JwtPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

// Creates a signed JWT token for a given creator.
// jti is a random 16-byte hex string — it uniquely identifies this token so we can revoke it later.
// Tokens expire in 7 days. HS256 is a symmetric signing algorithm (same secret to sign and verify).
function signToken(creatorId: string): { token: string; jti: string; expiresInSeconds: number } {
  const jti = randomBytes(16).toString('hex');
  const expiresInSeconds = 7 * 24 * 60 * 60; // 7 days
  const token = jwt.sign({ sub: creatorId, jti }, config.JWT_SECRET, {
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  });
  return { token, jti, expiresInSeconds };
}

// Verifies a JWT token sent by the client on every protected request.
// First tries the current secret; if that fails, tries a previous secret (supports key rotation
// without immediately invalidating all existing sessions).
// Also checks Redis to see if this token was explicitly revoked via logout.
export async function verifyToken(token: string): Promise<JwtPayload> {
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as JwtPayload;
  } catch {
    if (config.JWT_SECRET_PREVIOUS) {
      try {
        payload = jwt.verify(token, config.JWT_SECRET_PREVIOUS, {
          algorithms: ['HS256'],
        }) as JwtPayload;
      } catch {
        throw new AppError('Invalid token', 401, 'UNAUTHORIZED');
      }
    } else {
      throw new AppError('Invalid token', 401, 'UNAUTHORIZED');
    }
  }

  // Even if the token signature is valid, reject it if the user has logged out.
  // The jti was added to the Redis denylist at logout time.
  if (await isTokenDenylisted(payload.jti)) {
    throw new AppError('Token has been revoked', 401, 'UNAUTHORIZED');
  }

  return payload;
}

// Pre-computed bcrypt hash used when the email doesn't exist in the DB.
// bcrypt.compare is intentionally slow — if we skipped it for unknown emails, an attacker
// could measure the response time and discover which emails are registered (timing attack).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', 10);

// Registers a new creator account.
// Rejects duplicate emails, hashes the password before storing (never store plain text),
// then returns a JWT so the user is immediately logged in after signup.
export async function signup(email: string, password: string, displayName: string) {
  const existing = await prisma.creator.findUnique({ where: { email } });
  if (existing) throw new AppError('Email already in use', 409, 'CONFLICT');

  // bcrypt.hash with BCRYPT_ROUNDS (typically 10–12) is slow by design — makes brute-forcing harder.
  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);
  const creator = await prisma.creator.create({
    data: { email, passwordHash, displayName },
    select: { id: true, email: true, displayName: true, createdAt: true },
  });

  // Auth events are out-of-transaction — failures don't block the response
  await writeSecurityAudit({
    prisma,
    creatorId: creator.id,
    actorId: creator.id,
    action: 'creator.signup',
    targetType: 'creator',
    targetId: creator.id,
  });

  const { token } = signToken(creator.id);
  return { creator, token };
}

// Authenticates an existing creator.
// Always runs bcrypt.compare even if the email doesn't exist (using DUMMY_HASH) to prevent
// timing attacks. Only after both checks fail do we throw an error — and the error message
// is deliberately vague so attackers can't tell whether the email or password was wrong.
export async function login(email: string, password: string) {
  const creator = await prisma.creator.findUnique({ where: { email } });

  // Always compare to prevent timing attacks
  const hash = creator?.passwordHash ?? DUMMY_HASH;
  const valid = await bcrypt.compare(password, hash);

  if (!creator || !valid) {
    throw new AppError('Invalid email or password', 401, 'UNAUTHORIZED');
  }

  await writeSecurityAudit({
    prisma,
    creatorId: creator.id,
    actorId: creator.id,
    action: 'creator.login',
    targetType: 'creator',
    targetId: creator.id,
  });

  const { token } = signToken(creator.id);
  return {
    creator: { id: creator.id, email: creator.email, displayName: creator.displayName },
    token,
  };
}

// Invalidates a JWT by storing its jti in Redis for the remainder of its natural lifetime.
// JWTs are stateless (can't be "deleted"), so the denylist is the only way to revoke one.
// Redis TTL is set to the token's remaining seconds so the entry auto-cleans up when the token
// would have expired anyway — no manual cleanup needed.
export async function logout(jti: string, exp: number) {
  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    await denylistToken(jti, ttl);
  }
}

// Step 1 of password reset: generates a secure random token, stores only its SHA-256 hash
// in the DB (never the raw token), and would email the raw token to the user.
// Always returns 202 regardless of whether the email exists — prevents email enumeration
// (an attacker probing which emails are registered).
export async function requestPasswordReset(email: string) {
  const creator = await prisma.creator.findUnique({ where: { email } });
  // Always return success to prevent email enumeration
  if (!creator) return;

  // randomBytes(32) gives 256 bits of entropy — cryptographically unguessable.
  // We store the SHA-256 hash so that even if the DB is breached, tokens can't be used.
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.passwordResetToken.create({
    data: { creatorId: creator.id, tokenHash, expiresAt },
  });

  await writeSecurityAudit({
    prisma,
    creatorId: creator.id,
    actorId: creator.id,
    action: 'creator.password_reset_request',
    targetType: 'creator',
    targetId: creator.id,
  });

  // In production: send rawToken via email
  return rawToken;
}

// Step 2 of password reset: validates the token and updates the password.
// Uses a DB transaction so both the "mark token used" and "update password" writes either
// both succeed or both fail — no half-updated state possible.
export async function resetPassword(rawToken: string, newPassword: string) {
  // Hash the submitted token to compare against the stored hash.
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { creator: true },
  });

  // Reject if token doesn't exist, was already used, or has expired.
  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
  }

  const passwordHash = await bcrypt.hash(newPassword, config.BCRYPT_ROUNDS);

  // $transaction ensures both updates are atomic — prevents a scenario where the token
  // is marked used but the password never updates (or vice versa).
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.creator.update({
      where: { id: resetToken.creatorId },
      data: { passwordHash },
    }),
  ]);

  await writeSecurityAudit({
    prisma,
    creatorId: resetToken.creatorId,
    actorId: resetToken.creatorId,
    action: 'creator.password_reset_complete',
    targetType: 'creator',
    targetId: resetToken.creatorId,
  });
}
