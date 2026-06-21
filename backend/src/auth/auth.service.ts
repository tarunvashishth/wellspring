import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '../db/prisma';
import { config } from '../config';
import { AppError } from '../lib/errors';
import { denylistToken, isTokenDenylisted } from '../lib/redis';
import { writeSecurityAudit } from '../lib/audit';

interface JwtPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

function signToken(creatorId: string): { token: string; jti: string; expiresInSeconds: number } {
  const jti = randomBytes(16).toString('hex');
  const expiresInSeconds = 7 * 24 * 60 * 60; // 7 days
  const token = jwt.sign({ sub: creatorId, jti }, config.JWT_SECRET, {
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  });
  return { token, jti, expiresInSeconds };
}

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

  if (await isTokenDenylisted(payload.jti)) {
    throw new AppError('Token has been revoked', 401, 'UNAUTHORIZED');
  }

  return payload;
}

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', 10);

export async function signup(email: string, password: string, displayName: string) {
  const existing = await prisma.creator.findUnique({ where: { email } });
  if (existing) throw new AppError('Email already in use', 409, 'CONFLICT');

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

export async function logout(jti: string, exp: number) {
  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    await denylistToken(jti, ttl);
  }
}

export async function requestPasswordReset(email: string) {
  const creator = await prisma.creator.findUnique({ where: { email } });
  // Always return success to prevent email enumeration
  if (!creator) return;

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

export async function resetPassword(rawToken: string, newPassword: string) {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { creator: true },
  });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
  }

  const passwordHash = await bcrypt.hash(newPassword, config.BCRYPT_ROUNDS);

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
