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
  type LlmLog,
} from '@chromium-search/shared';

import {
  createToolContext,
  listCommits,
  readFileAtRevision,
  batchGetCommitDetails,
  batchGetDiffExcerpts,
  rankCommits,
  selectTopCandidates,
  analyzeQuery,
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

      // Build result
      return {
        answer: result.answer,
        evidence: result.evidence,
        debug: includeDebug
          ? {
              runId,
              toolCalls: toolContext.toolCalls,
              rankedCandidates: result.rankedCandidates,
              modelUsage: this.modelRouter.getUsageHistory(),
              llmLogs: this.modelRouter.getLogs(),
            }
          : { runId, toolCalls: [], rankedCandidates: [] },
      };
    } catch (error) {
      this.logger.error({ runId, error: String(error) }, 'Agent run failed');
      return this.createErrorResult(
        runId,
        `Error processing query: ${error instanceof Error ? error.message : String(error)}`,
        toolContext.toolCalls,
        this.modelRouter.getLogs()
      );
    } finally {
      this.modelRouter.clearUsageHistory();
    }
  }

  /**
   * Main agent execution loop
   */
  private async executeAgentLoop(
    _runId: string,
    scope: SessionScope,
    query: string,
    context: ToolContext
  ): Promise<{ answer: string; evidence: Evidence[]; rankedCandidates: RankedCandidate[] }> {
    // Step 1: Analyze query
    const queryAnalysis = analyzeQuery(query);
    let intent: QueryIntent = 'general';

    if (this.modelRouter.isAvailable()) {
      try {
        const classification = await this.modelRouter.classifyQuery(query, QUERY_CLASSIFICATION_PROMPT);
        intent = this.mapIntentString(classification.intent);
      } catch (error) {
        this.logger.warn({ error: String(error) }, 'Query classification failed, using heuristics');
        intent = this.inferIntentFromAnalysis(queryAnalysis);
      }
    } else {
      intent = this.inferIntentFromAnalysis(queryAnalysis);
    }

    this.logger.debug({ intent, queryAnalysis }, 'Query analyzed');

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

    // Step 3: Rank candidates
    if (retrieved.commits.length > 0) {
      // Heuristic ranking
      retrieved.rankedCandidates = rankCommits(retrieved.commits, {
        query,
        pathScope: scope.pathScope,
      });

      // Optional LLM reranking of top candidates
      if (this.modelRouter.isAvailable() && retrieved.rankedCandidates.length > 20) {
        try {
          const topForRerank = retrieved.rankedCandidates.slice(0, 50);
          const reranked = await this.modelRouter.rankCommitsLLM(
            query,
            topForRerank.map((r) => {
              const commit = retrieved.commits.find((c) => c.sha === r.sha);
              return {
                sha: r.sha,
                title: commit?.title ?? '',
                messageSnippet: commit?.messageSnippet,
              };
            }),
            RANKING_PROMPT
          );

          if (reranked.rankings.length > 0) {
            // Merge LLM rankings with heuristic rankings
            const llmRankMap = new Map(reranked.rankings.map((r) => [r.sha.slice(0, 8), r]));
            retrieved.rankedCandidates = retrieved.rankedCandidates.map((r) => {
              const llmRank = llmRankMap.get(r.sha.slice(0, 8));
              if (llmRank) {
                return {
                  sha: r.sha,
                  score: (r.score + llmRank.score) / 2,
                  reason: `${r.reason}; LLM: ${llmRank.reason}`,
                };
              }
              return r;
            });
            retrieved.rankedCandidates.sort((a, b) => b.score - a.score);
          }
        } catch (error) {
          this.logger.warn({ error: String(error) }, 'LLM reranking failed');
        }
      }
    }

    // Step 4: Deep dive based on intent
    const topK = selectTopCandidates(
      retrieved.rankedCandidates,
      this.getDeepDiveCount(intent),
      0.1
    );

    if (topK.length > 0) {
      await this.deepDive(context, topK, retrieved, intent, queryAnalysis);
    }

    // Step 5: Synthesize answer
    const answer = await this.synthesizeAnswer(query, intent, retrieved, context);

    // Step 6: Build evidence
    const evidence = this.buildEvidence(retrieved, topK);

    return {
      answer,
      evidence,
      rankedCandidates: retrieved.rankedCandidates.slice(0, 20),
    };
  }

  /**
   * Deep dive into top candidates
   */
  private async deepDive(
    context: ToolContext,
    candidates: RankedCandidate[],
    retrieved: RetrievedData,
    intent: QueryIntent,
    queryAnalysis: ReturnType<typeof analyzeQuery>
  ): Promise<void> {
    const shas = candidates.map((c) => c.sha);

    // Get commit details
    const detailsResult = await batchGetCommitDetails(context, shas);
    if (detailsResult.details) {
      for (const detail of detailsResult.details) {
        retrieved.details.set(detail.sha, detail);
      }
    }

    // For regression/file queries, get diffs
    if (intent === 'regression' || intent === 'file_change') {
      const diffsResult = await batchGetDiffExcerpts(
        context,
        shas.slice(0, 5), // Limit diff fetches
        { fileGlobs: queryAnalysis.potentialPaths.length > 0 ? queryAnalysis.potentialPaths : undefined }
      );
      if (diffsResult.diffs) {
        for (const diff of diffsResult.diffs) {
          retrieved.diffs.set(diff.sha, diff);
        }
      }
    }

    // For symbol lookup, try to read relevant files
    if (intent === 'symbol_lookup' && queryAnalysis.potentialPaths.length > 0) {
      for (const path of queryAnalysis.potentialPaths.slice(0, 2)) {
        const fileResult = await readFileAtRevision(context, path, 'HEAD');
        if (fileResult.success && fileResult.file) {
          retrieved.files.set(path, fileResult.file.excerpt);
        }
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
    _context: ToolContext
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
          complexity
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
    toolCalls: ToolCallRecord[] = [],
    llmLogs: LlmLog[] = []
  ): AgentRunResult {
    return {
      answer: message,
      evidence: [],
      debug: {
        runId,
        toolCalls,
        rankedCandidates: [],
        llmLogs,
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
   * Infer intent from query analysis
   */
  private inferIntentFromAnalysis(analysis: ReturnType<typeof analyzeQuery>): QueryIntent {
    if (analysis.isRegressionQuery) return 'regression';
    if (analysis.isSummaryQuery) return 'summary';
    if (analysis.isFileQuery) return 'file_change';
    if (analysis.potentialSymbols.length > 0) return 'symbol_lookup';
    return 'general';
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
