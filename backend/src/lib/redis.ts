import Redis from 'ioredis';
import { config } from '../config';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,  // fail fast — denylist is best-effort, don't block requests
      connectTimeout: 500,
      commandTimeout: 500,
    });
    _redis.on('error', (err) => {
      // Log but don't crash — Redis is used for denylist; a failure means
      // we fail open on that check, which is acceptable vs. taking the app down.
      console.error('[redis] connection error', err.message);
    });
  }
  return _redis;
}

const DENYLIST_PREFIX = 'jti:revoked:';

export async function denylistToken(jti: string, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().setex(`${DENYLIST_PREFIX}${jti}`, ttlSeconds, '1');
  } catch {
    // Fail open — logout still clears the client token; denylist is best-effort
    console.error('[redis] denylistToken failed (best-effort)');
  }
}

export async function isTokenDenylisted(jti: string): Promise<boolean> {
  try {
    const result = await getRedis().exists(`${DENYLIST_PREFIX}${jti}`);
    return result === 1;
  } catch {
    // Fail open — if Redis is unavailable, allow the token through
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
