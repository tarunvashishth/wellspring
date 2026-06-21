import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});
