/**
 * Agent Orchestrator
 * Coordinates the agentic loop for answering questions about Chromium changes
 * Uses OpenAI function calling to let the LLM explore commits via tools
 */

import OpenAI from 'openai';
import {
  AgentRunResult,
  Evidence,
  CommitEvidence,
  DiffEvidenceItem,
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
  getCommitDetails,
  getDiffExcerpt,
  searchCommits,
  type ToolContext,
} from '@chromium-search/tools';

import { ModelRouter, getModelRouter, type AgentToolDefinition } from '../models/router.js';
import {
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
  rankedCandidates: RankedCandidate[];
  foundCommitShas: Set<string>; // SHAs the agent identified as relevant
}

// ============================================================================
// Agent Tools Definition
// ============================================================================

const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_commits',
      description: 'Search through commit titles and messages for keywords. Use this to find commits related to specific topics, features, or bug fixes.',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            description: 'Keywords to search for in commit titles and messages',
            items: { type: 'string' },
          },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_commit_details',
      description: 'Get detailed information about a specific commit including the full commit message and list of changed files.',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'The commit SHA (can be short or full)',
          },
        },
        required: ['sha'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diff',
      description: 'Get the code diff/changes for a specific commit. Shows what lines were added and removed.',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'The commit SHA (can be short or full)',
          },
        },
        required: ['sha'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_relevant_commit',
      description: 'Mark a commit as relevant to the user query. Call this for each commit you determine is related to what the user is asking about.',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'The commit SHA',
          },
          reason: {
            type: 'string',
            description: 'Brief explanation of why this commit is relevant',
          },
        },
        required: ['sha', 'reason'],
      },
    },
  },
];

const AGENT_SYSTEM_PROMPT = `You are an expert at analyzing changes in the Chromium codebase. Your job is to find commits relevant to the user's question.

You have access to a list of commits in a specific range. Use the available tools to:
1. Search for commits by keywords in their titles/messages
2. Get detailed information about specific commits
3. View the actual code changes (diffs) for commits
4. Mark commits that are relevant to the user's question

Strategy:
- Start by searching for keywords related to the user's question
- For promising commits, get their details to understand what they do
- If needed, view the diff to see the actual code changes
- Mark each commit you find relevant with mark_relevant_commit

CRITICAL: You MUST call mark_relevant_commit for EVERY commit you determine is relevant BEFORE providing your final summary. Do not just describe relevant commits in text - you must explicitly mark them using the tool. If you found relevant commits but did not call mark_relevant_commit for them, your work is incomplete.

When you have marked all relevant commits (or determined there are none), provide a brief summary of what you found.

Available commits in range: {commit_count}
Sample commit titles:
{sample_commits}`;

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
                toolCalls: call.toolCalls,
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
   * Main agent execution loop with tool calling
   */
  private async executeAgentLoop(
    runId: string,
    scope: SessionScope,
    query: string,
    toolContext: ToolContext
  ): Promise<{ answer: string; evidence: Evidence[]; rankedCandidates: RankedCandidate[] }> {
    // Check if LLM is available
    if (!this.modelRouter.isAvailable()) {
      return {
        answer: 'LLM is not available. Please configure an OpenAI API key to use this service.',
        evidence: [],
        rankedCandidates: [],
      };
    }

    // Step 1: Retrieve all commits in the range
    const retrieved: RetrievedData = {
      commits: [],
      details: new Map(),
      diffs: new Map(),
      rankedCandidates: [],
      foundCommitShas: new Set(),
    };

    if (scope.rangeEnabled && scope.range) {
      const commitsResult = await listCommits(
        toolContext,
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

    if (retrieved.commits.length === 0) {
      return {
        answer: 'No commits found in the specified range.',
        evidence: [],
        rankedCandidates: [],
      };
    }

    // Step 2: Run the agentic exploration loop
    const relevantCommits: Map<string, string> = new Map(); // sha -> reason
    
    try {
      await this.runAgentExplorationLoop(
        runId,
        query,
        retrieved,
        toolContext,
        relevantCommits
      );
    } catch (error) {
      this.logger.error({ error: String(error) }, 'Agent exploration loop failed');
      // Continue with any commits found so far
    }

    this.logger.debug(
      { 
        relevantCommitsCount: relevantCommits.size, 
        shas: Array.from(relevantCommits.keys()).map(sha => sha.slice(0, 8)) 
      },
      'Agent exploration found relevant commits'
    );

    // Step 3: Rank the found commits using LLM
    if (relevantCommits.size > 0) {
      const foundCommits = Array.from(relevantCommits.entries()).map(([sha, reason]) => {
        const commit = retrieved.commits.find(c => c.sha === sha || c.sha.startsWith(sha));
        return {
          sha: commit?.sha ?? sha,
          title: commit?.title ?? 'Unknown',
          messageSnippet: commit?.messageSnippet,
          reason,
        };
      });

      try {
        const ranked = await this.modelRouter.rankCommitsLLM(
          query,
          foundCommits,
          RANKING_PROMPT,
          runId
        );

        this.logger.debug(
          {
            rankedCount: ranked.rankings.length,
            shas: ranked.rankings.map(r => r.sha.slice(0, 8))
          },
          'LLM ranking completed'
        );
        if (ranked.rankings.length > 0) {
          retrieved.rankedCandidates = ranked.rankings.map((r) => ({
            sha: this.expandSha(r.sha, retrieved.commits),
            score: r.score,
            reason: r.reason,
          }));
        } else {
          // Use the found commits in order
          retrieved.rankedCandidates = foundCommits.map((c, idx) => ({
            sha: this.expandSha(c.sha, retrieved.commits),
            score: 1 - (idx / foundCommits.length),
            reason: c.reason,
          }));
        }
      } catch (error) {
        this.logger.error({ error: String(error) }, 'LLM ranking failed');
        // Use found commits without ranking
        retrieved.rankedCandidates = Array.from(relevantCommits.entries()).map(([sha, reason], idx) => ({
          sha: this.expandSha(sha, retrieved.commits),
          score: 1 - (idx / relevantCommits.size),
          reason,
        }));
      }
    }

    // Step 4: Fetch details and diffs for top ranked commits
    const topK = retrieved.rankedCandidates.slice(0, 10);
    if (topK.length > 0) {
      await this.fetchDetailsAndDiffs(toolContext, topK, retrieved);
    }

    // Step 5: Synthesize final answer
    const answer = await this.synthesizeAnswer(query, retrieved, runId);

    // Step 6: Build evidence
    const evidence = this.buildEvidence(retrieved, topK);

    return {
      answer,
      evidence,
      rankedCandidates: retrieved.rankedCandidates.slice(0, 20),
    };
  }

  /**
   * Run the agentic exploration loop where LLM calls tools to find relevant commits
   */
  private async runAgentExplorationLoop(
    runId: string,
    query: string,
    retrieved: RetrievedData,
    toolContext: ToolContext,
    relevantCommits: Map<string, string>
  ): Promise<void> {
    const maxIterations = 10;
    let iteration = 0;

    // Build system prompt with commit info
    const sampleCommits = retrieved.commits
      .slice(0, 20)
      .map(c => `- ${c.sha.slice(0, 8)}: ${c.title}`)
      .join('\n');

    const systemPrompt = AGENT_SYSTEM_PROMPT
      .replace('{commit_count}', String(retrieved.commits.length))
      .replace('{sample_commits}', sampleCommits);

    const userPrompt = `User question: ${query}\n\nPlease search for and identify commits relevant to this question.`;

    // Initialize conversation
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    while (iteration < maxIterations) {
      iteration++;
      this.logger.debug({ iteration }, 'Agent exploration iteration');

      // Call LLM with tools
      const result = await this.modelRouter.complete({
        messages,
        tier: 'fast',
        maxTokens: 2048,
        temperature: 0.3,
        tools: AGENT_TOOLS as OpenAI.ChatCompletionTool[],
        runId,
      });

      // Check if LLM wants to call tools
      if (!result.toolCalls || result.toolCalls.length === 0) {
        // LLM is done exploring - record final response
        this.modelRouter.recordAgentExplorationCall(
          runId,
          this.config.openai.fastModel,
          systemPrompt,
          `[Iteration ${iteration}] Agent finished exploring`,
          result.content || '(no content)',
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.latencyMs,
          []
        );
        this.logger.debug({ content: result.content?.slice(0, 100) }, 'Agent finished exploring');
        
        // Fallback: Extract any commit SHAs mentioned in the final response that weren't marked
        // This handles cases where the agent discusses relevant commits but forgets to call mark_relevant_commit
        if (result.content && relevantCommits.size === 0) {
          const extractedShas = this.extractCommitShasFromResponse(result.content, retrieved.commits);
          if (extractedShas.length > 0) {
            this.logger.info(
              { extractedCount: extractedShas.length, shas: extractedShas.map(s => s.slice(0, 8)) },
              'Agent mentioned commits without marking them - extracting from response'
            );
            for (const sha of extractedShas) {
              relevantCommits.set(sha, 'Mentioned in agent response (not explicitly marked)');
            }
          }
        }
        
        break;
      }

      // Process tool calls and collect results for debugging
      const toolCallRecords: Array<{ name: string; arguments: string; result: string }> = [];
      const toolResults: OpenAI.ChatCompletionMessageParam[] = [];
      
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const toolResult = await this.executeToolCall(
          toolCall,
          retrieved,
          toolContext,
          relevantCommits
        );

        // Record for debugging
        toolCallRecords.push({
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          result: toolResult,
        });

        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // Record this iteration's exploration with tool calls
      this.modelRouter.recordAgentExplorationCall(
        runId,
        this.config.openai.fastModel,
        systemPrompt,
        `[Iteration ${iteration}] Tool calls: ${result.toolCalls.map(tc => tc.function.name).join(', ')}`,
        result.content || '(tool calls only)',
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.latencyMs,
        toolCallRecords
      );

      // Add tool results to conversation
      messages.push(...toolResults);
    }
  }

  /**
   * Execute a single tool call
   */
  private async executeToolCall(
    toolCall: OpenAI.ChatCompletionMessageToolCall,
    retrieved: RetrievedData,
    toolContext: ToolContext,
    relevantCommits: Map<string, string>
  ): Promise<string> {
    const { name, arguments: argsJson } = toolCall.function;
    
    try {
      const args = JSON.parse(argsJson);

      switch (name) {
        case 'search_commits': {
          const keywords = args.keywords as string[];
          const result = searchCommits(retrieved.commits, keywords, { maxResults: undefined });
          if (result.matches && result.matches.length > 0) {
            return JSON.stringify({
              found: result.count,
              commits: result.matches.map(m => ({
                sha: m.sha.slice(0, 8),
                title: m.title,
                matchedIn: m.matchedIn,
              })),
            });
          }
          return JSON.stringify({ found: 0, message: 'No commits found matching those keywords' });
        }

        case 'get_commit_details': {
          const sha = this.expandSha(args.sha, retrieved.commits);
          
          // Check if we already have the details
          let details = retrieved.details.get(sha);
          if (!details) {
            const result = await getCommitDetails(toolContext, sha);
            if (result.success && result.details) {
              details = result.details;
              retrieved.details.set(sha, details);
            } else {
              return JSON.stringify({ error: result.error || 'Failed to get commit details' });
            }
          }

          return JSON.stringify({
            sha: details.sha.slice(0, 8),
            title: details.title,
            message: details.message.slice(0, 500) + (details.message.length > 500 ? '...' : ''),
            filesChanged: details.filesChanged?.slice(0, 10),
            totalFilesChanged: details.filesChanged?.length ?? 0,
          });
        }

        case 'get_diff': {
          const sha = this.expandSha(args.sha, retrieved.commits);
          
          // Check if we already have the diff
          let diff = retrieved.diffs.get(sha);
          if (!diff) {
            const result = await getDiffExcerpt(toolContext, sha);
            if (result.success && result.diff) {
              diff = result.diff;
              retrieved.diffs.set(sha, diff);
            } else {
              return JSON.stringify({ error: result.error || 'Failed to get diff' });
            }
          }

          return JSON.stringify({
            sha: diff.sha.slice(0, 8),
            files: diff.diffs.slice(0, 3).map(d => ({
              file: d.file,
              excerpt: d.excerpt.slice(0, 500) + (d.excerpt.length > 500 ? '...' : ''),
            })),
          });
        }

        case 'mark_relevant_commit': {
          const sha = this.expandSha(args.sha, retrieved.commits);
          const reason = args.reason as string;
          relevantCommits.set(sha, reason);
          return JSON.stringify({ success: true, message: `Marked commit ${sha.slice(0, 8)} as relevant` });
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      return JSON.stringify({ error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /**
   * Fetch details and diffs for top ranked commits
   */
  private async fetchDetailsAndDiffs(
    context: ToolContext,
    candidates: RankedCandidate[],
    retrieved: RetrievedData
  ): Promise<void> {
    for (const candidate of candidates) {
      // Get details if not already fetched
      if (!retrieved.details.has(candidate.sha)) {
        const result = await getCommitDetails(context, candidate.sha);
        if (result.success && result.details) {
          retrieved.details.set(candidate.sha, result.details);
        }
      }

      // Get diff if not already fetched
      if (!retrieved.diffs.has(candidate.sha)) {
        const result = await getDiffExcerpt(context, candidate.sha);
        if (result.success && result.diff) {
          retrieved.diffs.set(candidate.sha, result.diff);
        }
      }
    }
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
   * Extract commit SHAs mentioned in the agent's response text
   * This is a fallback for when the agent discusses commits but forgets to call mark_relevant_commit
   */
  private extractCommitShasFromResponse(responseText: string, commits: CommitSummary[]): string[] {
    const foundShas: string[] = [];
    
    // Match patterns that look like commit SHAs (7-40 hex characters)
    // Common patterns: "abc1234", "commit abc1234", "SHA: abc1234", etc.
    const shaPattern = /\b([0-9a-f]{7,40})\b/gi;
    const matches = responseText.matchAll(shaPattern);
    
    for (const match of matches) {
      const potentialSha = match[1].toLowerCase();
      
      // Try to find a matching commit in our list
      const matchedCommit = commits.find(c => 
        c.sha.toLowerCase().startsWith(potentialSha) || 
        potentialSha.startsWith(c.sha.toLowerCase().slice(0, 8))
      );
      
      if (matchedCommit && !foundShas.includes(matchedCommit.sha)) {
        foundShas.push(matchedCommit.sha);
      }
    }
    
    return foundShas;
  }

  /**
   * Synthesize the final answer
   */
  private async synthesizeAnswer(
    query: string,
    retrieved: RetrievedData,
    runId: string
  ): Promise<string> {
    // Build context for answer generation
    const contextParts: string[] = [];

    // Add commit summaries
    if (retrieved.commits.length > 0) {
      contextParts.push(`## Commit Range Overview\nTotal commits in range: ${retrieved.commits.length}`);
      
      if (retrieved.rankedCandidates.length > 0) {
        const topCommits = retrieved.rankedCandidates.slice(0, 10);
        contextParts.push('\n### Relevant Commits Found:');
        for (const candidate of topCommits) {
          const commit = retrieved.commits.find((c) => c.sha === candidate.sha);
          if (commit) {
            contextParts.push(`- **${commit.sha.slice(0, 8)}**: ${commit.title}`);
            contextParts.push(`  Relevance: ${candidate.reason}`);
          }
        }
      } else {
        contextParts.push('\nNo commits were identified as relevant to the query.');
      }
    }

    // Add commit details
    if (retrieved.details.size > 0) {
      contextParts.push('\n### Commit Details:');
      for (const [sha, detail] of retrieved.details) {
        // Only include details for ranked candidates
        if (!retrieved.rankedCandidates.some(c => c.sha === sha)) continue;
        
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
        // Only include diffs for ranked candidates
        if (!retrieved.rankedCandidates.some(c => c.sha === sha)) continue;
        
        for (const fileDiff of diff.diffs.slice(0, 3)) {
          contextParts.push(`\n#### ${sha.slice(0, 8)} - ${fileDiff.file}`);
          contextParts.push('```diff\n' + fileDiff.excerpt.slice(0, 1000) + '\n```');
          if (fileDiff.truncated) {
            contextParts.push('(truncated)');
          }
        }
      }
    }

    const evidenceContext = contextParts.join('\n');

    // Use LLM to generate answer
    if (this.modelRouter.isAvailable()) {
      try {
        const result = await this.modelRouter.generateAnswer(
          query,
          evidenceContext,
          ANSWER_SYNTHESIS_PROMPT,
          'strong',
          runId
        );
        return result.content;
      } catch (error) {
        this.logger.warn({ error: String(error) }, 'Answer generation failed, using fallback');
      }
    }

    // Fallback
    return this.generateFallbackAnswer(retrieved);
  }

  /**
   * Generate a fallback answer without LLM
   */
  private generateFallbackAnswer(retrieved: RetrievedData): string {
    const parts: string[] = [];

    if (retrieved.commits.length === 0) {
      return 'No commits found in the specified range.';
    }

    parts.push(`Found ${retrieved.commits.length} commits in the range.\n`);

    if (retrieved.rankedCandidates.length > 0) {
      parts.push('## Relevant Commits\n');
      const top = retrieved.rankedCandidates.slice(0, 5);
      for (const candidate of top) {
        const commit = retrieved.commits.find((c) => c.sha === candidate.sha);
        if (commit) {
          parts.push(`- **${commit.sha.slice(0, 8)}**: ${commit.title}`);
          parts.push(`  Relevance: ${candidate.reason}`);
        }
      }
    } else {
      parts.push('No commits were identified as relevant to the query.');
    }

    return parts.join('\n');
  }

  /**
   * Build evidence array from retrieved data
   */
  private buildEvidence(retrieved: RetrievedData, topCandidates: RankedCandidate[]): Evidence[] {
    const evidence: Evidence[] = [];

    // Add commit evidence for all ranked candidates
    for (const candidate of topCandidates) {
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

    // Add diff evidence for ranked candidates
    for (const candidate of topCandidates.slice(0, 5)) {
      const diff = retrieved.diffs.get(candidate.sha);
      if (diff) {
        for (const fileDiff of diff.diffs.slice(0, 2)) {
          evidence.push({
            type: 'diff_excerpt',
            sha: candidate.sha,
            file: fileDiff.file,
            excerpt: fileDiff.excerpt.slice(0, 500),
            truncated: fileDiff.truncated || fileDiff.excerpt.length > 500,
          } as DiffEvidenceItem);
        }
      }
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
