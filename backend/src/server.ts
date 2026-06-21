import app from './app';
import { config } from './config';
import { prisma } from './db/prisma';
import { closeRedis } from './lib/redis';
import { logger } from './lib/logger';

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Wellspring API started');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await Promise.all([prisma.$disconnect(), closeRedis()]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
