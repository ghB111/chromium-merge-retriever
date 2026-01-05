/**
 * Error Handler Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { ServiceError, createLogger } from '@chromium-search/shared';

const logger = createLogger('ErrorHandler');

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log the error
  logger.error(
    {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    },
    'Request error'
  );

  // Handle known service errors
  if (err instanceof ServiceError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    res.status(400).json({
      error: {
        code: 'DATABASE_ERROR',
        message: 'Database operation failed',
      },
    });
    return;
  }

  // Handle unknown errors
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
