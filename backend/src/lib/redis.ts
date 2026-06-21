import Redis from 'ioredis';
import { config } from '../config';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
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
  await getRedis().setex(`${DENYLIST_PREFIX}${jti}`, ttlSeconds, '1');
}

export async function isTokenDenylisted(jti: string): Promise<boolean> {
  const result = await getRedis().exists(`${DENYLIST_PREFIX}${jti}`);
  return result === 1;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
