/**
 * Model Router for selecting appropriate LLM based on task complexity
 */

import OpenAI from 'openai';
import {
  getConfig,
  createLogger,
  createTimer,
  type Logger,
  type ModelUsage,
  type LlmCallType,
} from '@chromium-search/shared';

// ============================================================================
// Types
// ============================================================================

export type ModelTier = 'fast' | 'strong';

export interface ModelConfig {
  tier: ModelTier;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface CompletionRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  runId?: string; // For run-scoped usage tracking
  tools?: OpenAI.ChatCompletionTool[];
}

export interface CompletionResult {
  content: string;
  usage: ModelUsage;
  finishReason: string;
  toolCalls?: OpenAI.ChatCompletionMessageToolCall[];
}

// Agent tool definitions for OpenAI function calling
export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; items?: { type: string } }>;
      required?: string[];
    };
  };
}

export interface AgentLoopResult {
  content: string;
  toolCallsMade: Array<{ name: string; arguments: string; result: string }>;
  usage: ModelUsage;
}

// Agent tool call record for debug purposes
export interface AgentToolCallRecord {
  name: string;
  arguments: string;
  result: string;
}

// LLM Call Record for debug purposes
export interface LlmCallRecord {
  callType: LlmCallType;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: Date;
  // For agent_exploration calls, track the tool calls made
  toolCalls?: AgentToolCallRecord[];
}

// ============================================================================
// Complexity Estimation
// ============================================================================

export interface ComplexityFactors {
  commitCount: number;
  hasDiffs: boolean;
  hasFileContent: boolean;
  queryType: 'summary' | 'regression' | 'file_change' | 'general';
}

export function estimateComplexity(factors: ComplexityFactors): ModelTier {
  // Use strong model for:
  // - Regression analysis (requires deeper reasoning)
  // - Large commit counts with diffs
  
  if (factors.queryType === 'regression') {
    return 'strong';
  }
  
  if (factors.hasDiffs && factors.commitCount > 10) {
    return 'strong';
  }
  
  if (factors.hasFileContent) {
    return 'strong';
  }
  
  // Fast model for:
  // - Simple summaries
  // - Small commit ranges
  // - Initial classification
  return 'fast';
}

// ============================================================================
// Model Router
// ============================================================================

export class ModelRouter {
  private client: OpenAI | null = null;
  private logger: Logger;
  private config = getConfig();
  // Run-scoped history storage to avoid concurrency issues with the singleton
  private usageHistoryByRun: Map<string, ModelUsage[]> = new Map();
  private llmCallHistoryByRun: Map<string, LlmCallRecord[]> = new Map();

  constructor() {
    this.logger = createLogger('ModelRouter');
    
    if (this.config.openai.apiKey) {
      this.client = new OpenAI({
        apiKey: this.config.openai.apiKey,
        ...(this.config.openai.baseUrl && { baseURL: this.config.openai.baseUrl }),
      });
      
      if (this.config.openai.baseUrl) {
        this.logger.info({ baseUrl: this.config.openai.baseUrl }, 'Using custom OpenAI base URL');
      }
    } else {
      this.logger.warn('OpenAI API key not configured, LLM features will be disabled');
    }
  }

  /**
   * Initialize history tracking for a run
   */
  initRunHistory(runId: string): void {
    if (!this.usageHistoryByRun.has(runId)) {
      this.usageHistoryByRun.set(runId, []);
    }
    if (!this.llmCallHistoryByRun.has(runId)) {
      this.llmCallHistoryByRun.set(runId, []);
    }
  }

  /**
   * Record an LLM call for debugging purposes (run-scoped)
   */
  private recordLlmCall(
    runId: string,
    callType: LlmCallType,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    response: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    toolCalls?: AgentToolCallRecord[]
  ): void {
    let history = this.llmCallHistoryByRun.get(runId);
    if (!history) {
      history = [];
      this.llmCallHistoryByRun.set(runId, history);
    }
    history.push({
      callType,
      model,
      systemPrompt,
      userPrompt,
      response,
      inputTokens,
      outputTokens,
      latencyMs,
      createdAt: new Date(),
      toolCalls,
    });
  }

  /**
   * Record an agent exploration call with tool calls (public method for orchestrator)
   */
  recordAgentExplorationCall(
    runId: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    response: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    toolCalls: AgentToolCallRecord[]
  ): void {
    this.recordLlmCall(
      runId,
      'agent_exploration',
      model,
      systemPrompt,
      userPrompt,
      response,
      inputTokens,
      outputTokens,
      latencyMs,
      toolCalls
    );
  }

  /**
   * Record usage for a specific run
   */
  private recordUsage(runId: string, usage: ModelUsage): void {
    let history = this.usageHistoryByRun.get(runId);
    if (!history) {
      history = [];
      this.usageHistoryByRun.set(runId, history);
    }
    history.push(usage);
  }

  /**
   * Check if LLM is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Get model configuration for a tier
   */
  getModelConfig(tier: ModelTier): ModelConfig {
    return tier === 'fast'
      ? {
          tier: 'fast',
          model: this.config.openai.fastModel,
          maxTokens: 2048,
          temperature: 0.3,
        }
      : {
          tier: 'strong',
          model: this.config.openai.strongModel,
          maxTokens: 4096,
          temperature: 0.5,
        };
  }

  /**
   * Complete a chat request
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized - API key required');
    }

    const tier = request.tier ?? 'fast';
    const modelConfig = this.getModelConfig(tier);
    const timer = createTimer();

    this.logger.debug(
      { tier, model: modelConfig.model, messageCount: request.messages.length },
      'Sending completion request'
    );

    const response = await this.client.chat.completions.create({
      model: modelConfig.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? modelConfig.maxTokens,
      temperature: request.temperature ?? modelConfig.temperature,
      ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
    });

    const content = response.choices[0]?.message?.content ?? '';
    const finishReason = response.choices[0]?.finish_reason ?? 'unknown';
    const toolCalls = response.choices[0]?.message?.tool_calls;
    
    const usage: ModelUsage = {
      model: modelConfig.model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: timer.elapsed(),
    };

    // Track usage if runId provided (for run-scoped history)
    if (request.runId) {
      this.recordUsage(request.runId, usage);
    }

    this.logger.debug(
      { 
        model: modelConfig.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        finishReason,
        hasToolCalls: !!toolCalls?.length,
      },
      'Completion response received'
    );

    return { content, usage, finishReason, toolCalls };
  }

  /**
   * Classify a query to determine intent
   */
  async classifyQuery(
    query: string,
    systemPrompt: string,
    runId?: string
  ): Promise<{ intent: string; usage: ModelUsage }> {
    const modelConfig = this.getModelConfig('fast');
    const result = await this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      tier: 'fast',
      maxTokens: 50,
      temperature: 0.1,
      runId,
    });

    // Record the LLM call for debugging (run-scoped)
    if (runId) {
      this.recordLlmCall(
        runId,
        'query_classification',
        modelConfig.model,
        systemPrompt,
        query,
        result.content,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.latencyMs
      );
    }

    return {
      intent: result.content.trim().toLowerCase(),
      usage: result.usage,
    };
  }

  /**
   * Rank commits using LLM
   */
  async rankCommitsLLM(
    query: string,
    commits: Array<{ sha: string; title: string; messageSnippet?: string }>,
    systemPrompt: string,
    runId?: string
  ): Promise<{ rankings: Array<{ sha: string; score: number; reason: string }>; usage: ModelUsage }> {
    const commitList = commits
      .map((c) => `- ${c.sha.slice(0, 8)}: ${c.title}`)
      .join('\n');

    const userPrompt = `Question: ${query}\n\nCommits:\n${commitList}\n\nReturn JSON array of top relevant commits with scores (0-1) and reasons.`;
    const modelConfig = this.getModelConfig('fast');

    const result = await this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tier: 'fast',
      maxTokens: 1000,
      temperature: 0.3,
      responseFormat: 'json',
      runId,
    });

    // Record the LLM call for debugging (run-scoped)
    if (runId) {
      this.recordLlmCall(
        runId,
        'ranking',
        modelConfig.model,
        systemPrompt,
        userPrompt,
        result.content,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.latencyMs
      );
    }

    try {
      const rankings = JSON.parse(result.content);
      return { rankings: Array.isArray(rankings) ? rankings : [], usage: result.usage };
    } catch {
      this.logger.warn({ content: result.content }, 'Failed to parse ranking JSON');
      return { rankings: [], usage: result.usage };
    }
  }

  /**
   * Generate final answer
   */
  async generateAnswer(
    query: string,
    context: string,
    systemPrompt: string,
    tier: ModelTier = 'strong',
    runId?: string
  ): Promise<CompletionResult> {
    const userPrompt = `Question: ${query}\n\nContext and Evidence:\n${context}`;
    const modelConfig = this.getModelConfig(tier);

    const result = await this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tier,
      maxTokens: 4096,
      temperature: 0.5,
      runId,
    });

    // Record the LLM call for debugging (run-scoped)
    if (runId) {
      this.recordLlmCall(
        runId,
        'answer_synthesis',
        modelConfig.model,
        systemPrompt,
        userPrompt,
        result.content,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.latencyMs
      );
    }

    return result;
  }

  /**
   * Get usage history for a specific run
   */
  getUsageHistory(runId: string): ModelUsage[] {
    return [...(this.usageHistoryByRun.get(runId) ?? [])];
  }

  /**
   * Clear usage history for a specific run
   */
  clearUsageHistory(runId: string): void {
    this.usageHistoryByRun.delete(runId);
  }

  /**
   * Get LLM call history for a specific run
   */
  getLlmCallHistory(runId: string): LlmCallRecord[] {
    return [...(this.llmCallHistoryByRun.get(runId) ?? [])];
  }

  /**
   * Clear LLM call history for a specific run
   */
  clearLlmCallHistory(runId: string): void {
    this.llmCallHistoryByRun.delete(runId);
  }

  /**
   * Clear all history for a specific run (convenience method)
   */
  clearRunHistory(runId: string): void {
    this.usageHistoryByRun.delete(runId);
    this.llmCallHistoryByRun.delete(runId);
  }
}

// ============================================================================
// Factory
// ============================================================================

let routerInstance: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!routerInstance) {
    routerInstance = new ModelRouter();
  }
  return routerInstance;
}

export function resetModelRouter(): void {
  routerInstance = null;
}
