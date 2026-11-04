import pino from 'pino';
import { env } from '../config/env';

/** pino-pretty is a devDependency, so production images don't have it. */
function canPrettyPrint(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development' && canPrettyPrint()
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
