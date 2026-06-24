import Redis from 'ioredis';
import { config } from '../config';

// Singleton Redis client — created once on first use, reused for all subsequent calls.
// null means not yet created (lazy initialization — don't connect until actually needed).
let _redis: Redis | null = null;

// getRedis() creates the client on first call and returns it on every subsequent call.
// This is the "singleton pattern" — ensures we don't create a new connection for every request.
// Key settings explained:
//   lazyConnect: don't actually connect to Redis until the first command is sent
//   maxRetriesPerRequest: 0 — don't retry on failure; fail immediately so requests aren't delayed
//   connectTimeout/commandTimeout: 500ms — if Redis is slow, fail fast rather than hanging
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

// Prefix all keys with 'jti:revoked:' to namespace them — good practice to avoid collisions
// if Redis is shared with other applications or features in the future.
const DENYLIST_PREFIX = 'jti:revoked:';

// Adds a JWT's unique ID to Redis with a TTL (time-to-live).
// setex key ttl value: sets a key that Redis automatically deletes after `ttlSeconds`.
// We set the TTL to match the token's remaining lifetime — no need to ever manually clean up.
// Wrapped in try/catch: if Redis is down, we still want logout to succeed (client-side token
// is cleared regardless — the risk of a revoked token being accepted is low and temporary).
export async function denylistToken(jti: string, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().setex(`${DENYLIST_PREFIX}${jti}`, ttlSeconds, '1');
  } catch {
    // Fail open — logout still clears the client token; denylist is best-effort
    console.error('[redis] denylistToken failed (best-effort)');
  }
}

// Checks if a JWT has been revoked. Called on every authenticated request in auth.middleware.
// exists() returns 1 if the key is present, 0 if not.
// Fail open: if Redis is unavailable, we return false (allow the token through) rather than
// blocking all authenticated traffic. A brief Redis outage should not take down the whole app.
export async function isTokenDenylisted(jti: string): Promise<boolean> {
  try {
    const result = await getRedis().exists(`${DENYLIST_PREFIX}${jti}`);
    return result === 1;
  } catch {
    // Fail open — if Redis is unavailable, allow the token through
    return false;
  }
}

// Gracefully closes the Redis connection during server shutdown.
// Called from server.ts in the SIGTERM/SIGINT handler so the process exits cleanly.
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
