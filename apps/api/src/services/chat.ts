/**
 * Chat Service
 * Handles chat message processing and agent orchestration
 */

import { PrismaClient } from '@prisma/client';
import {
  ChatResponse,
  ChatMessageRequest,
  ValidationError,
  createLogger,
  hashString,
  generateRunId,
  createTimer,
  getConfig,
  type Logger,
} from '@chromium-search/shared';

import { getOrchestrator } from '@chromium-search/agent';
import { SessionService, getSessionService } from './session.js';

// ============================================================================
// Chat Service
// ============================================================================

export class ChatService {
  private sessionService: SessionService;
  private logger: Logger;
  private config = getConfig();

  constructor(prisma: PrismaClient) {
    this.sessionService = getSessionService(prisma);
    this.logger = createLogger('ChatService');
  }

  /**
   * Process a chat message
   */
  async processMessage(
    sessionId: string,
    request: ChatMessageRequest,
    includeDebug?: boolean
  ): Promise<ChatResponse> {
    const timer = createTimer();
    const runId = generateRunId();

    // Validate input size
    if (request.text.length > this.config.security.maxInputSizeBytes) {
      throw new ValidationError(
        `Message too long (max ${this.config.security.maxInputSizeBytes} bytes)`
      );
    }

    // Get session
    const session = await this.sessionService.getSession(sessionId);
    const queryHash = await hashString(request.text);

    this.logger.info(
      { sessionId, runId, queryLength: request.text.length },
      'Processing chat message'
    );

    // Record run start
    await this.sessionService.recordRun(sessionId, runId, queryHash, 'running');

    // Store user message
    await this.sessionService.addMessage(sessionId, 'user', request.text);

    try {
      // Run the agent
      const orchestrator = getOrchestrator();
      const result = await orchestrator.run({
        sessionId,
        scope: session.scope,
        query: request.text,
        includeDebug: includeDebug ?? this.config.debug.enabled,
      });

      // Store assistant message
      await this.sessionService.addMessage(sessionId, 'assistant', result.answer, runId);

      // Record run completion
      const durationMs = timer.elapsed();
      await this.sessionService.recordRun(
        sessionId,
        runId,
        queryHash,
        'completed',
        durationMs,
        result.debug?.toolCalls.length ?? 0,
        result.debug?.toolCalls.reduce((sum: number, tc: { bytes: number }) => sum + tc.bytes, 0) ?? 0
      );

      // Record LLM calls for debugging
      if (result.debug?.llmCalls && result.debug.llmCalls.length > 0) {
        await this.sessionService.recordLlmCalls(runId, result.debug.llmCalls);
      }

      this.logger.info(
        { sessionId, runId, durationMs, evidenceCount: result.evidence.length },
        'Chat message processed successfully'
      );

      return result;
    } catch (error) {
      // Record run failure
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.sessionService.recordRun(
        sessionId,
        runId,
        queryHash,
        'failed',
        timer.elapsed(),
        0,
        0,
        errorMessage
      );

      this.logger.error({ sessionId, runId, error: errorMessage }, 'Chat message processing failed');
      throw error;
    }
  }

  /**
   * Get chat history for a session
   */
  async getChatHistory(sessionId: string): Promise<Array<{ role: string; content: string; createdAt: Date }>> {
    return this.sessionService.getMessages(sessionId);
  }
}

// ============================================================================
// Factory
// ============================================================================

let serviceInstance: ChatService | null = null;

export function getChatService(prisma: PrismaClient): ChatService {
  if (!serviceInstance) {
    serviceInstance = new ChatService(prisma);
  }
  return serviceInstance;
}
