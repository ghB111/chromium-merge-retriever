/**
 * Request Logger Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { createLogger, createTimer, generateId } from '@chromium-search/shared';

const logger = createLogger('RequestLogger');

// Extend Express Request type to include requestId
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = generateId();
  req.requestId = requestId;
  const timer = createTimer();

  // Log request start
  logger.info(
    {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      userAgent: req.get('user-agent'),
    },
    'Request started'
  );

  // Log response on finish
  res.on('finish', () => {
    logger.info(
      {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: timer.elapsed(),
      },
      'Request completed'
    );
  });

  next();
}
