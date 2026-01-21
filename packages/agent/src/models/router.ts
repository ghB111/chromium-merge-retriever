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
}

export interface CompletionResult {
  content: string;
  usage: ModelUsage;
  finishReason: string;
}

// ============================================================================
// Complexity Estimation
// ============================================================================

export interface ComplexityFactors {
  commitCount: number;
  hasDiffs: boolean;
  hasFileContent: boolean;
  queryType: 'summary' | 'regression' | 'symbol_lookup' | 'file_change' | 'general';
}

export function estimateComplexity(factors: ComplexityFactors): ModelTier {
  // Use strong model for:
  // - Regression analysis (requires deeper reasoning)
  // - Large commit counts with diffs
  // - Symbol lookup (may need understanding code relationships)
  
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
  private usageHistory: ModelUsage[] = [];

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
    });

    const content = response.choices[0]?.message?.content ?? '';
    const finishReason = response.choices[0]?.finish_reason ?? 'unknown';
    
    const usage: ModelUsage = {
      model: modelConfig.model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: timer.elapsed(),
    };

    this.usageHistory.push(usage);

    this.logger.debug(
      { 
        model: modelConfig.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        finishReason,
      },
      'Completion response received'
    );

    return { content, usage, finishReason };
  }

  /**
   * Classify a query to determine intent
   */
  async classifyQuery(
    query: string,
    systemPrompt: string
  ): Promise<{ intent: string; usage: ModelUsage }> {
    const result = await this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      tier: 'fast',
      maxTokens: 50,
      temperature: 0.1,
    });

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
    systemPrompt: string
  ): Promise<{ rankings: Array<{ sha: string; score: number; reason: string }>; usage: ModelUsage }> {
    const commitList = commits
      .map((c) => `- ${c.sha.slice(0, 8)}: ${c.title}`)
      .join('\n');

    const result = await this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Question: ${query}\n\nCommits:\n${commitList}\n\nReturn JSON array of top relevant commits with scores (0-1) and reasons.`,
        },
      ],
      tier: 'fast',
      maxTokens: 1000,
      temperature: 0.3,
      responseFormat: 'json',
    });

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
    tier: ModelTier = 'strong'
  ): Promise<CompletionResult> {
    return this.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Question: ${query}\n\nContext and Evidence:\n${context}`,
        },
      ],
      tier,
      maxTokens: 4096,
      temperature: 0.5,
    });
  }

  /**
   * Get usage history
   */
  getUsageHistory(): ModelUsage[] {
    return [...this.usageHistory];
  }

  /**
   * Clear usage history
   */
  clearUsageHistory(): void {
    this.usageHistory = [];
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
