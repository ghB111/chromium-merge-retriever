/**
 * Messages API Routes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AgentProgressUpdate } from '@chromium-search/agent';
import { getChatService } from '../services/chat.js';
import {
  ValidationError,
  getConfig,
  type ChatResponse,
} from '@chromium-search/shared';

// ============================================================================
// Validation Schemas
// ============================================================================

const sendMessageSchema = z.object({
  text: z.string().min(1).max(16384),
});

type StreamEvent =
  | { type: 'progress'; progress: AgentProgressUpdate }
  | { type: 'result'; response: ChatResponse }
  | { type: 'error'; error: { message: string; code?: string; status?: number } };

function parseRequestBody(body: unknown): { text: string } {
  const parseResult = sendMessageSchema.safeParse(body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.errors,
    });
  }

  return parseResult.data;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }

  const maybeStatus = (error as { statusCode?: unknown }).statusCode;
  return typeof maybeStatus === 'number' ? maybeStatus : undefined;
}

function toStreamError(error: unknown): { message: string; code?: string; status?: number } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    code: getErrorCode(error),
    status: getErrorStatus(error),
  };
}

function writeStreamEvent(res: Response, event: StreamEvent): void {
  res.write(`${JSON.stringify(event)}\n`);
}

// ============================================================================
// Route Factory
// ============================================================================

export function createMessagesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const chatService = getChatService(prisma);

  /**
   * POST /v1/sessions/:sessionId/messages
   * Send a chat message and get a response
   */
  router.post('/:sessionId/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const includeDebug =
        req.headers['x-include-debug'] === 'true' || getConfig().debug.enabled;

      const body = parseRequestBody(req.body);

      const response = await chatService.processMessage(
        sessionId,
        { text: body.text },
        includeDebug
      );

      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/sessions/:sessionId/messages/stream
   * Send a chat message and stream progress updates
   */
  router.post('/:sessionId/messages/stream', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const includeDebug =
        req.headers['x-include-debug'] === 'true' || getConfig().debug.enabled;
      const body = parseRequestBody(req.body);

      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      let clientDisconnected = false;
      res.on('close', () => {
        clientDisconnected = true;
      });

      const emit = (event: StreamEvent): void => {
        if (clientDisconnected || res.writableEnded || res.destroyed) {
          return;
        }
        writeStreamEvent(res, event);
      };

      try {
        const response = await chatService.processMessage(
          sessionId,
          { text: body.text },
          includeDebug,
          (progress) => {
            emit({ type: 'progress', progress });
          }
        );

        emit({ type: 'result', response });
      } catch (error) {
        emit({ type: 'error', error: toStreamError(error) });
      } finally {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/sessions/:sessionId/history
   * Get chat history for a session
   */
  router.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const history = await chatService.getChatHistory(sessionId);
      res.json({ messages: history });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
