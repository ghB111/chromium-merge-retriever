/**
 * Agent Tools for Gitiles Operations
 * These tools wrap the GitilesClient for use by the agent orchestrator
 */

import {
  CommitSummary,
  CommitDetails,
  DiffExcerpt,
  FileExcerpt,
  ParsedRangeUrl,
  ToolCallRecord,
  ValidationError,
  BudgetExceededError,
  createTimer,
  isValidSha,
  type RunBudget,
  type BudgetUsage,
} from '@chromium-search/shared';

import { getGitilesClient, type GetDiffOptions } from './client.js';
import { parseRangeFromGitilesUrl } from './url-parser.js';

// ============================================================================
// Tool Context
// ============================================================================

export interface ToolContext {
  repoBaseUrl: string;
  budget: RunBudget;
  usage: BudgetUsage;
  toolCalls: ToolCallRecord[];
}

export function createToolContext(repoBaseUrl: string, budget: RunBudget): ToolContext {
  return {
    repoBaseUrl,
    budget,
    usage: {
      toolCallsUsed: 0,
      bytesUsed: 0,
      timeElapsedMs: 0,
    },
    toolCalls: [],
  };
}

// ============================================================================
// Budget Checking
// ============================================================================

function checkBudget(context: ToolContext, toolName: string): void {
  if (context.usage.toolCallsUsed >= context.budget.maxToolCalls) {
    throw new BudgetExceededError(`Tool call budget exceeded (max: ${context.budget.maxToolCalls})`, {
      tool: toolName,
      used: context.usage.toolCallsUsed,
      max: context.budget.maxToolCalls,
    });
  }
  
  if (context.usage.bytesUsed >= context.budget.maxTotalBytes) {
    throw new BudgetExceededError(`Bytes budget exceeded (max: ${context.budget.maxTotalBytes})`, {
      tool: toolName,
      used: context.usage.bytesUsed,
      max: context.budget.maxTotalBytes,
    });
  }
}

function recordToolCall(
  context: ToolContext,
  toolName: string,
  timer: { elapsed: () => number },
  bytes: number,
  ok: boolean,
  error?: string
): void {
  const record: ToolCallRecord = {
    tool: toolName,
    ms: timer.elapsed(),
    bytes,
    ok,
    error,
  };
  
  context.toolCalls.push(record);
  context.usage.toolCallsUsed++;
  context.usage.bytesUsed += bytes;
  context.usage.timeElapsedMs += record.ms;
}

// ============================================================================
// Tool: Parse Range URL
// ============================================================================

export interface ParseRangeUrlResult {
  success: boolean;
  data?: ParsedRangeUrl;
  error?: string;
}

export function parseRangeUrl(url: string): ParseRangeUrlResult {
  try {
    const data = parseRangeFromGitilesUrl(url);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Tool: List Commits
// ============================================================================

export interface ListCommitsResult {
  success: boolean;
  commits?: CommitSummary[];
  count?: number;
  error?: string;
}

export async function listCommits(
  context: ToolContext,
  startSha: string,
  endSha: string,
  options?: { pathScope?: string[]; maxCommits?: number }
): Promise<ListCommitsResult> {
  const toolName = 'listCommits';
  checkBudget(context, toolName);
  
  const timer = createTimer();
  const client = getGitilesClient();
  
  try {
    // Validate SHAs
    // if (!isValidSha(startSha) || !isValidSha(endSha)) {
    //   throw new ValidationError('Invalid SHA format');
    // }
    
    const commits = await client.listCommits({
      repoBaseUrl: context.repoBaseUrl,
      startSha,
      endSha,
      pathScope: options?.pathScope,
      maxCommits: options?.maxCommits,
    });
    
    const bytes = JSON.stringify(commits).length;
    recordToolCall(context, toolName, timer, bytes, true);
    
    return {
      success: true,
      commits,
      count: commits.length,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    recordToolCall(context, toolName, timer, 0, false, errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// ============================================================================
// Tool: Get Commit Details
// ============================================================================

export interface GetCommitDetailsResult {
  success: boolean;
  details?: CommitDetails;
  error?: string;
}

export async function getCommitDetails(
  context: ToolContext,
  sha: string
): Promise<GetCommitDetailsResult> {
  const toolName = 'getCommitDetails';
  checkBudget(context, toolName);
  
  const timer = createTimer();
  const client = getGitilesClient();
  
  try {
    if (!isValidSha(sha)) {
      throw new ValidationError('Invalid SHA format');
    }
    
    const details = await client.getCommitDetails(context.repoBaseUrl, sha);
    
    const bytes = JSON.stringify(details).length;
    recordToolCall(context, toolName, timer, bytes, true);
    
    return {
      success: true,
      details,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    recordToolCall(context, toolName, timer, 0, false, errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// ============================================================================
// Tool: Get Diff Excerpt
// ============================================================================

export interface GetDiffExcerptResult {
  success: boolean;
  diff?: DiffExcerpt;
  error?: string;
}

export async function getDiffExcerpt(
  context: ToolContext,
  sha: string,
  options?: GetDiffOptions
): Promise<GetDiffExcerptResult> {
  const toolName = 'getDiffExcerpt';
  checkBudget(context, toolName);
  
  const timer = createTimer();
  const client = getGitilesClient();
  
  try {
    if (!isValidSha(sha)) {
      throw new ValidationError('Invalid SHA format');
    }
    
    const diff = await client.getDiffExcerpt(context.repoBaseUrl, sha, {
      maxLines: options?.maxLines ?? context.budget.maxDiffLinesPerCommit,
      fileGlobs: options?.fileGlobs,
      contextLines: options?.contextLines,
    });
    
    const bytes = JSON.stringify(diff).length;
    recordToolCall(context, toolName, timer, bytes, true);
    
    return {
      success: true,
      diff,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    recordToolCall(context, toolName, timer, 0, false, errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// ============================================================================
// Tool: Read File at Revision
// ============================================================================

export interface ReadFileResult {
  success: boolean;
  file?: FileExcerpt;
  error?: string;
}

export async function readFileAtRevision(
  context: ToolContext,
  path: string,
  revision: string,
  options?: { maxBytes?: number }
): Promise<ReadFileResult> {
  const toolName = 'readFileAtRevision';
  checkBudget(context, toolName);
  
  const timer = createTimer();
  const client = getGitilesClient();
  
  try {
    // Allow HEAD or valid SHA
    if (revision !== 'HEAD' && !isValidSha(revision)) {
      throw new ValidationError('Invalid revision format (expected SHA or HEAD)');
    }
    
    // Validate path (basic security check)
    if (path.includes('..') || path.startsWith('/')) {
      throw new ValidationError('Invalid file path');
    }
    
    const file = await client.readFileAtRevision(
      context.repoBaseUrl,
      path,
      revision,
      { maxBytes: options?.maxBytes ?? context.budget.maxFileBytes }
    );
    
    const bytes = JSON.stringify(file).length;
    recordToolCall(context, toolName, timer, bytes, true);
    
    return {
      success: true,
      file,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    recordToolCall(context, toolName, timer, 0, false, errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// ============================================================================
// Tool: Batch Get Commit Details
// ============================================================================

export interface BatchGetCommitDetailsResult {
  success: boolean;
  details?: CommitDetails[];
  errors?: Array<{ sha: string; error: string }>;
}

export async function batchGetCommitDetails(
  context: ToolContext,
  shas: string[]
): Promise<BatchGetCommitDetailsResult> {
  // Check if we have enough budget for all calls
  const remaining = context.budget.maxToolCalls - context.usage.toolCallsUsed;
  if (shas.length > remaining) {
    return {
      success: false,
      errors: [{ sha: '*', error: `Not enough budget for ${shas.length} calls (remaining: ${remaining})` }],
    };
  }
  
  const results: CommitDetails[] = [];
  const errors: Array<{ sha: string; error: string }> = [];
  
  for (const sha of shas) {
    const result = await getCommitDetails(context, sha);
    if (result.success && result.details) {
      results.push(result.details);
    } else {
      errors.push({ sha, error: result.error || 'Unknown error' });
    }
  }
  
  return {
    success: errors.length === 0,
    details: results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ============================================================================
// Tool: Batch Get Diff Excerpts
// ============================================================================

export interface BatchGetDiffExcerptsResult {
  success: boolean;
  diffs?: DiffExcerpt[];
  errors?: Array<{ sha: string; error: string }>;
}

export async function batchGetDiffExcerpts(
  context: ToolContext,
  shas: string[],
  options?: GetDiffOptions
): Promise<BatchGetDiffExcerptsResult> {
  // Check if we have enough budget for all calls
  const remaining = context.budget.maxToolCalls - context.usage.toolCallsUsed;
  if (shas.length > remaining) {
    return {
      success: false,
      errors: [{ sha: '*', error: `Not enough budget for ${shas.length} calls (remaining: ${remaining})` }],
    };
  }
  
  const results: DiffExcerpt[] = [];
  const errors: Array<{ sha: string; error: string }> = [];
  
  for (const sha of shas) {
    const result = await getDiffExcerpt(context, sha, options);
    if (result.success && result.diff) {
      results.push(result.diff);
    } else {
      errors.push({ sha, error: result.error || 'Unknown error' });
    }
  }
  
  return {
    success: errors.length === 0,
    diffs: results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ============================================================================
// Tool Registry
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'parseRangeUrl',
    description: 'Parse a Gitiles log URL to extract the commit range (startSha, endSha) and repository URL',
    parameters: {
      url: { type: 'string', description: 'Gitiles log URL' },
    },
  },
  {
    name: 'listCommits',
    description: 'List all commits in a range. Returns commit summaries (SHA, title, author, date). Use this first to understand what changes exist.',
    parameters: {
      startSha: { type: 'string', description: 'Start commit SHA' },
      endSha: { type: 'string', description: 'End commit SHA' },
      pathScope: { type: 'array', description: 'Optional: filter to paths starting with these prefixes', items: { type: 'string' } },
      maxCommits: { type: 'number', description: 'Optional: maximum number of commits to return' },
    },
  },
  {
    name: 'getCommitDetails',
    description: 'Get detailed information about a specific commit including full message and list of changed files',
    parameters: {
      sha: { type: 'string', description: 'Commit SHA' },
    },
  },
  {
    name: 'getDiffExcerpt',
    description: 'Get the diff/patch for a commit. Returns truncated diff excerpts for each changed file.',
    parameters: {
      sha: { type: 'string', description: 'Commit SHA' },
      fileGlobs: { type: 'array', description: 'Optional: filter to files matching these patterns', items: { type: 'string' } },
      maxLines: { type: 'number', description: 'Optional: maximum lines per file diff' },
    },
  },
  {
    name: 'readFileAtRevision',
    description: 'Read the contents of a file at a specific revision (commit SHA or HEAD)',
    parameters: {
      path: { type: 'string', description: 'File path relative to repository root' },
      revision: { type: 'string', description: 'Commit SHA or HEAD' },
    },
  },
  {
    name: 'batchGetCommitDetails',
    description: 'Get details for multiple commits in one call. More efficient than individual calls.',
    parameters: {
      shas: { type: 'array', description: 'Array of commit SHAs', items: { type: 'string' } },
    },
  },
  {
    name: 'batchGetDiffExcerpts',
    description: 'Get diffs for multiple commits in one call. More efficient than individual calls.',
    parameters: {
      shas: { type: 'array', description: 'Array of commit SHAs', items: { type: 'string' } },
      fileGlobs: { type: 'array', description: 'Optional: filter to files matching these patterns', items: { type: 'string' } },
    },
  },
];
