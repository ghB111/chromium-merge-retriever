/**
 * Agent Orchestrator
 * Coordinates the agent loop for answering questions about Chromium changes
 */

import {
  AgentRunResult,
  Evidence,
  CommitEvidence,
  DiffEvidenceItem,
  FileEvidenceItem,
  QueryIntent,
  RankedCandidate,
  ToolCallRecord,
  createLogger,
  createTimer,
  generateRunId,
  getConfig,
  withTimeout,
  type Logger,
  type SessionScope,
  type CommitSummary,
  type CommitDetails,
  type DiffExcerpt,
} from '@chromium-search/shared';

import {
  createToolContext,
  listCommits,
  batchGetCommitDetails,
  batchGetDiffExcerpts,
  type ToolContext,
} from '@chromium-search/tools';

import { ModelRouter, getModelRouter, estimateComplexity } from '../models/router.js';
import {
  QUERY_CLASSIFICATION_PROMPT,
  RANKING_PROMPT,
  ANSWER_SYNTHESIS_PROMPT,
} from '../prompts/system.js';

// ============================================================================
// Types
// ============================================================================

export interface RunOptions {
  sessionId: string;
  scope: SessionScope;
  query: string;
  includeDebug?: boolean;
}

interface RetrievedData {
  commits: CommitSummary[];
  details: Map<string, CommitDetails>;
  diffs: Map<string, DiffExcerpt>;
  files: Map<string, string>;
  rankedCandidates: RankedCandidate[];
}

// ============================================================================
// Orchestrator
// ============================================================================

export class AgentOrchestrator {
  private logger: Logger;
  private config = getConfig();
  private modelRouter: ModelRouter;

  constructor() {
    this.logger = createLogger('AgentOrchestrator');
    this.modelRouter = getModelRouter();
  }

  /**
   * Run the agent to answer a query
   */
  async run(options: RunOptions): Promise<AgentRunResult> {
    const { sessionId, scope, query, includeDebug = this.config.debug.enabled } = options;
    const runId = generateRunId();
    const timer = createTimer();

    this.logger.info({ runId, sessionId, query: query.slice(0, 100) }, 'Starting agent run');

    // Validate scope
    if (scope.rangeEnabled && !scope.range) {
      return this.createErrorResult(runId, 'Commit range is enabled but not specified. Please provide a range URL or SHA range.');
    }

    const repoBaseUrl = this.config.gitiles.fullRepoUrl;
    const toolContext = createToolContext(repoBaseUrl, this.config.budgets);

    // Initialize run-scoped history tracking
    this.modelRouter.initRunHistory(runId);

    try {
      // Run with timeout
      const result = await withTimeout(
        this.executeAgentLoop(runId, scope, query, toolContext),
        this.config.budgets.timeoutMs,
        'Agent run timed out'
      );

      this.logger.info(
        { runId, elapsed: timer.elapsed(), toolCalls: toolContext.toolCalls.length },
        'Agent run completed'
      );

      // Build result (using run-scoped history)
      const llmCalls = this.modelRouter.getLlmCallHistory(runId);
      return {
        answer: result.answer,
        evidence: result.evidence,
        debug: includeDebug
          ? {
              runId,
              toolCalls: toolContext.toolCalls,
              rankedCandidates: result.rankedCandidates,
              modelUsage: this.modelRouter.getUsageHistory(runId),
              llmCalls: llmCalls.map(call => ({
                callType: call.callType,
                model: call.model,
                systemPrompt: call.systemPrompt,
                userPrompt: call.userPrompt,
                response: call.response,
                inputTokens: call.inputTokens,
                outputTokens: call.outputTokens,
                latencyMs: call.latencyMs,
              })),
            }
          : { runId, toolCalls: [], rankedCandidates: [] },
      };
    } catch (error) {
      this.logger.error({ runId, error: String(error) }, 'Agent run failed');
      return this.createErrorResult(
        runId,
        `Error processing query: ${error instanceof Error ? error.message : String(error)}`,
        toolContext.toolCalls
      );
    } finally {
      // Clean up run-scoped history (only affects this run, not concurrent requests)
      this.modelRouter.clearRunHistory(runId);
    }
  }

  /**
   * Main agent execution loop
   */
  private async executeAgentLoop(
    runId: string,
    scope: SessionScope,
    query: string,
    context: ToolContext
  ): Promise<{ answer: string; evidence: Evidence[]; rankedCandidates: RankedCandidate[] }> {
    // Check if LLM is available - required for classification and ranking
    if (!this.modelRouter.isAvailable()) {
      return {
        answer: 'LLM is not available. Please configure an OpenAI API key to use this service.',
        evidence: [],
        rankedCandidates: [],
      };
    }

    // Step 1: Classify query intent using LLM only (no heuristics)
    let intent: QueryIntent;

    try {
      const classification = await this.modelRouter.classifyQuery(query, QUERY_CLASSIFICATION_PROMPT, runId);
      intent = this.mapIntentString(classification.intent);
      this.logger.debug({ intent }, 'Query intent classified by LLM');
    } catch (error) {
      this.logger.error({ error: String(error) }, 'Query classification failed');
      return {
        answer: `Failed to classify query: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
        rankedCandidates: [],
      };
    }

    // Step 2: Retrieve commits
    const retrieved: RetrievedData = {
      commits: [],
      details: new Map(),
      diffs: new Map(),
      files: new Map(),
      rankedCandidates: [],
    };

    if (scope.rangeEnabled && scope.range) {
      const commitsResult = await listCommits(
        context,
        scope.range.startSha,
        scope.range.endSha,
        { pathScope: scope.pathScope, maxCommits: this.config.defaults.maxCommits }
      );

      if (!commitsResult.success || !commitsResult.commits) {
        return {
          answer: `Failed to retrieve commits: ${commitsResult.error}`,
          evidence: [],
          rankedCandidates: [],
        };
      }

      retrieved.commits = commitsResult.commits;
      this.logger.debug({ count: retrieved.commits.length }, 'Retrieved commits');
    }

    // Step 3: Rank candidates using LLM only (no heuristics, no slicing)
    if (retrieved.commits.length > 0) {
      try {
        // Send ALL commits to LLM for ranking (no context limit slicing)
        const ranked = await this.modelRouter.rankCommitsLLM(
          query,
          retrieved.commits.map((commit) => ({
            sha: commit.sha,
            title: commit.title,
            messageSnippet: commit.messageSnippet,
          })),
          RANKING_PROMPT,
          runId
        );

        if (ranked.rankings.length > 0) {
          // Use LLM rankings directly
          retrieved.rankedCandidates = ranked.rankings.map((r) => ({
            sha: this.expandSha(r.sha, retrieved.commits),
            score: r.score,
            reason: r.reason,
          }));
          this.logger.debug({ count: retrieved.rankedCandidates.length }, 'LLM ranked commits');
        } else {
          this.logger.warn('LLM returned no rankings, using commit order');
          // Fallback: use original order with neutral scores
          retrieved.rankedCandidates = retrieved.commits.map((c, idx) => ({
            sha: c.sha,
            score: 1 - (idx / retrieved.commits.length),
            reason: 'default order',
          }));
        }
      } catch (error) {
        this.logger.error({ error: String(error) }, 'LLM ranking failed');
        return {
          answer: `Failed to rank commits: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
          rankedCandidates: [],
        };
      }
    }

    // Step 4: Deep dive into top candidates
    const topK = retrieved.rankedCandidates.slice(0, this.getDeepDiveCount(intent));

    if (topK.length > 0) {
      await this.deepDive(context, topK, retrieved);
    }

    // Step 5: Synthesize answer
    const answer = await this.synthesizeAnswer(query, intent, retrieved, context, runId);

    // Step 6: Build evidence
    const evidence = this.buildEvidence(retrieved, topK);

    return {
      answer,
      evidence,
      rankedCandidates: retrieved.rankedCandidates.slice(0, 20),
    };
  }

  /**
   * Expand a short SHA to full SHA by matching against commits
   */
  private expandSha(shortSha: string, commits: CommitSummary[]): string {
    const normalized = shortSha.toLowerCase();
    const match = commits.find((c) => c.sha.toLowerCase().startsWith(normalized));
    return match?.sha ?? shortSha;
  }

  /**
   * Deep dive into top candidates
   */
  private async deepDive(
    context: ToolContext,
    candidates: RankedCandidate[],
    retrieved: RetrievedData
  ): Promise<void> {
    const shas = candidates.map((c) => c.sha);

    // Get commit details for all candidates
    const detailsResult = await batchGetCommitDetails(context, shas);
    if (detailsResult.details) {
      for (const detail of detailsResult.details) {
        retrieved.details.set(detail.sha, detail);
      }
    }

    // Fetch diffs for ALL intents (not just regression/file_change)
    // Increased limit from 5 to 10 commits
    const diffsResult = await batchGetDiffExcerpts(
      context,
      shas.slice(0, 10)
    );
    if (diffsResult.diffs) {
      for (const diff of diffsResult.diffs) {
        retrieved.diffs.set(diff.sha, diff);
      }
    }
  }

  /**
   * Synthesize the final answer
   */
  private async synthesizeAnswer(
    query: string,
    intent: QueryIntent,
    retrieved: RetrievedData,
    _context: ToolContext,
    runId: string
  ): Promise<string> {
    // Build context for answer generation
    const contextParts: string[] = [];

    // Add commit summaries
    if (retrieved.commits.length > 0) {
      contextParts.push(`## Commit Range Overview\nTotal commits in range: ${retrieved.commits.length}`);
      
      if (retrieved.rankedCandidates.length > 0) {
        const topCommits = retrieved.rankedCandidates.slice(0, 10);
        contextParts.push('\n### Top Relevant Commits:');
        for (const candidate of topCommits) {
          const commit = retrieved.commits.find((c) => c.sha === candidate.sha);
          if (commit) {
            contextParts.push(`- **${commit.sha.slice(0, 8)}**: ${commit.title}`);
            contextParts.push(`  Score: ${candidate.score.toFixed(2)} - ${candidate.reason}`);
          }
        }
      }
    }

    // Add commit details
    if (retrieved.details.size > 0) {
      contextParts.push('\n### Commit Details:');
      for (const [sha, detail] of retrieved.details) {
        contextParts.push(`\n#### ${sha.slice(0, 8)}: ${detail.title}`);
        contextParts.push(`Message:\n${detail.message.slice(0, 500)}${detail.message.length > 500 ? '...' : ''}`);
        if (detail.filesChanged && detail.filesChanged.length > 0) {
          contextParts.push(`Files changed: ${detail.filesChanged.slice(0, 10).join(', ')}${detail.filesChanged.length > 10 ? '...' : ''}`);
        }
      }
    }

    // Add diffs
    if (retrieved.diffs.size > 0) {
      contextParts.push('\n### Diff Excerpts:');
      for (const [sha, diff] of retrieved.diffs) {
        for (const fileDiff of diff.diffs.slice(0, 3)) {
          contextParts.push(`\n#### ${sha.slice(0, 8)} - ${fileDiff.file}`);
          contextParts.push('```diff\n' + fileDiff.excerpt.slice(0, 1000) + '\n```');
          if (fileDiff.truncated) {
            contextParts.push('(truncated)');
          }
        }
      }
    }

    // Add file content
    if (retrieved.files.size > 0) {
      contextParts.push('\n### File Content:');
      for (const [path, content] of retrieved.files) {
        contextParts.push(`\n#### ${path}`);
        contextParts.push('```\n' + content.slice(0, 2000) + '\n```');
      }
    }

    const evidenceContext = contextParts.join('\n');

    // Use LLM if available
    if (this.modelRouter.isAvailable()) {
      const complexity = estimateComplexity({
        commitCount: retrieved.commits.length,
        hasDiffs: retrieved.diffs.size > 0,
        hasFileContent: retrieved.files.size > 0,
        queryType: intent,
      });

      try {
        const result = await this.modelRouter.generateAnswer(
          query,
          evidenceContext,
          ANSWER_SYNTHESIS_PROMPT,
          complexity,
          runId
        );
        return result.content;
      } catch (error) {
        this.logger.warn({ error: String(error) }, 'Answer generation failed, using fallback');
      }
    }

    // Fallback: Generate a simple answer without LLM
    return this.generateFallbackAnswer(query, intent, retrieved);
  }

  /**
   * Generate a fallback answer without LLM
   */
  private generateFallbackAnswer(
    _query: string,
    intent: QueryIntent,
    retrieved: RetrievedData
  ): string {
    const parts: string[] = [];

    if (retrieved.commits.length === 0) {
      return 'No commits found in the specified range.';
    }

    parts.push(`Found ${retrieved.commits.length} commits in the range.\n`);

    if (retrieved.rankedCandidates.length > 0) {
      parts.push('## Most Relevant Commits\n');
      const top = retrieved.rankedCandidates.slice(0, 5);
      for (const candidate of top) {
        const commit = retrieved.commits.find((c) => c.sha === candidate.sha);
        if (commit) {
          parts.push(`- **${commit.sha.slice(0, 8)}**: ${commit.title}`);
          const detail = retrieved.details.get(commit.sha);
          if (detail?.filesChanged && detail.filesChanged.length > 0) {
            parts.push(`  Files: ${detail.filesChanged.slice(0, 5).join(', ')}`);
          }
        }
      }
    }

    if (intent === 'summary') {
      parts.push('\n## Summary');
      parts.push('To get a more detailed analysis, please ensure OpenAI API key is configured.');
    }

    return parts.join('\n');
  }

  /**
   * Build evidence array from retrieved data
   */
  private buildEvidence(retrieved: RetrievedData, topCandidates: RankedCandidate[]): Evidence[] {
    const evidence: Evidence[] = [];

    // Add commit evidence
    for (const candidate of topCandidates.slice(0, 10)) {
      const commit = retrieved.commits.find((c) => c.sha === candidate.sha);
      if (commit) {
        evidence.push({
          type: 'commit',
          sha: commit.sha,
          url: commit.url,
          whyRelevant: candidate.reason,
        } as CommitEvidence);
      }
    }

    // Add diff evidence
    for (const [sha, diff] of retrieved.diffs) {
      for (const fileDiff of diff.diffs.slice(0, 3)) {
        evidence.push({
          type: 'diff_excerpt',
          sha,
          file: fileDiff.file,
          excerpt: fileDiff.excerpt.slice(0, 500),
          truncated: fileDiff.truncated || fileDiff.excerpt.length > 500,
        } as DiffEvidenceItem);
      }
    }

    // Add file evidence
    for (const [path, content] of retrieved.files) {
      evidence.push({
        type: 'file_excerpt',
        revision: 'HEAD',
        path,
        excerpt: content.slice(0, 500),
        truncated: content.length > 500,
      } as FileEvidenceItem);
    }

    return evidence;
  }

  /**
   * Create an error result
   */
  private createErrorResult(
    runId: string,
    message: string,
    toolCalls: ToolCallRecord[] = []
  ): AgentRunResult {
    return {
      answer: message,
      evidence: [],
      debug: {
        runId,
        toolCalls,
        rankedCandidates: [],
      },
    };
  }

  /**
   * Map intent string to QueryIntent type
   */
  private mapIntentString(intent: string): QueryIntent {
    const mapping: Record<string, QueryIntent> = {
      summary: 'summary',
      regression: 'regression',
      symbol_lookup: 'symbol_lookup',
      file_change: 'file_change',
      general: 'general',
    };
    return mapping[intent] ?? 'general';
  }

  /**
   * Get number of commits to deep dive based on intent
   */
  private getDeepDiveCount(intent: QueryIntent): number {
    switch (intent) {
      case 'summary':
        return 5; // Fewer deep dives for summaries
      case 'regression':
        return 15; // More for regression analysis
      case 'symbol_lookup':
        return 10;
      case 'file_change':
        return 10;
      default:
        return 10;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let orchestratorInstance: AgentOrchestrator | null = null;

export function getOrchestrator(): AgentOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AgentOrchestrator();
  }
  return orchestratorInstance;
}

export function resetOrchestrator(): void {
  orchestratorInstance = null;
}
