/**
 * Messages API Routes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getChatService } from '../services/chat.js';
import { ValidationError, getConfig } from '@chromium-search/shared';

// ============================================================================
// Validation Schemas
// ============================================================================

const sendMessageSchema = z.object({
  text: z.string().min(1).max(16384),
});

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

      // Validate request body
      const parseResult = sendMessageSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new ValidationError('Invalid request body', {
          errors: parseResult.error.errors,
        });
      }

      const response = await chatService.processMessage(
        sessionId,
        { text: parseResult.data.text },
        includeDebug
      );

      res.json(response);
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
