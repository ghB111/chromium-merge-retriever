/**
 * Core types for the Chromium Agentic Search Service
 */

// ============================================================================
// Session Types
// ============================================================================

export interface CommitRange {
  startSha: string;
  endSha: string;
}

export interface SessionScope {
  rangeEnabled: boolean;
  range: CommitRange | null;
  pathScope: string[];
}

export interface Session {
  sessionId: string;
  scope: SessionScope;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Commit Types
// ============================================================================

export interface CommitSummary {
  sha: string;
  title: string;
  author?: string;
  committer?: string;
  date?: string;
  messageSnippet?: string;
  url: string;
}

export interface CommitDetails {
  sha: string;
  title: string;
  message: string;
  author?: string;
  committer?: string;
  authorDate?: string;
  committerDate?: string;
  filesChanged?: string[];
  url: string;
}

export interface DiffFile {
  file: string;
  excerpt: string;
  truncated: boolean;
}

export interface DiffExcerpt {
  sha: string;
  diffs: DiffFile[];
}

export interface FileExcerpt {
  path: string;
  revision: string;
  excerpt: string;
  truncated: boolean;
  url: string;
}

// ============================================================================
// Evidence Types
// ============================================================================

export type EvidenceType = 'commit' | 'diff_excerpt' | 'file_excerpt';

export interface CommitEvidence {
  type: 'commit';
  sha: string;
  url: string;
  whyRelevant: string;
}

export interface DiffEvidenceItem {
  type: 'diff_excerpt';
  sha: string;
  file: string;
  excerpt: string;
  truncated: boolean;
}

export interface FileEvidenceItem {
  type: 'file_excerpt';
  revision: string;
  path: string;
  excerpt: string;
  truncated: boolean;
}

export type Evidence = CommitEvidence | DiffEvidenceItem | FileEvidenceItem;

// ============================================================================
// Tool Call Types
// ============================================================================

export interface ToolCallRecord {
  tool: string;
  ms: number;
  bytes: number;
  ok: boolean;
  error?: string;
}

export interface RankedCandidate {
  sha: string;
  score: number;
  reason: string;
}

export interface DebugInfo {
  runId: string;
  toolCalls: ToolCallRecord[];
  rankedCandidates: RankedCandidate[];
  modelUsage?: ModelUsage[];
  llmCalls?: LlmCallDebugInfo[];
}

export interface LlmCallDebugInfo {
  callType: LlmCallType;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ChatResponse {
  answer: string;
  evidence: Evidence[];
  debug?: DebugInfo;
}

export interface ScopeUpdateRequest {
  rangeEnabled?: boolean;
  rangeUrl?: string;
  range?: CommitRange;
  pathScope?: string[];
}

export interface ChatMessageRequest {
  text: string;
}

// ============================================================================
// Gitiles Types
// ============================================================================

export type GitRefType = 'sha' | 'tag';

export interface ParsedRangeUrl {
  startSha: string;      // Keep name for compatibility (can be SHA or tag)
  endSha: string;        // Keep name for compatibility (can be SHA or tag)
  startRefType: GitRefType;
  endRefType: GitRefType;
  repoBaseUrl: string;
}

export interface GitilesLogEntry {
  commit: string;
  tree?: string;
  parents?: string[];
  author?: {
    name?: string;
    email?: string;
    time?: string;
  };
  committer?: {
    name?: string;
    email?: string;
    time?: string;
  };
  message?: string;
}

export interface GitilesLogResponse {
  log: GitilesLogEntry[];
  next?: string;
}

// ============================================================================
// Agent Types
// ============================================================================

export type QueryIntent = 
  | 'summary'           // "what changed" summary
  | 'regression'        // "why regression" diagnosis
  | 'symbol_lookup'     // symbol/class existence at old revision
  | 'file_change'       // file/component scoped change
  | 'general';          // general question

export interface AgentContext {
  sessionId: string;
  runId: string;
  scope: SessionScope;
  query: string;
  intent?: QueryIntent;
}

export interface AgentRunResult {
  answer: string;
  evidence: Evidence[];
  debug: DebugInfo;
}

// ============================================================================
// Budget Types
// ============================================================================

export interface RunBudget {
  maxToolCalls: number;
  maxTotalBytes: number;
  maxDiffLinesPerCommit: number;
  maxFileBytes: number;
  timeoutMs: number;
}

export interface BudgetUsage {
  toolCallsUsed: number;
  bytesUsed: number;
  timeElapsedMs: number;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export type CacheKeyType = 'commits' | 'commit_details' | 'file_content';

// ============================================================================
// Error Types
// ============================================================================

export class ServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', 404, details);
    this.name = 'NotFoundError';
  }
}

export class GitilesError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'GITILES_ERROR', 502, details);
    this.name = 'GitilesError';
  }
}

export class BudgetExceededError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BUDGET_EXCEEDED', 400, details);
    this.name = 'BudgetExceededError';
  }
}

// ============================================================================
// Pre-Saved Range Types
// ============================================================================

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error';

export interface PreSavedRange {
  id: string;
  name: string;
  gitilesUrl: string;
  repoBaseUrl: string;
  startSha: string;
  endSha: string;
  downloadStatus: DownloadStatus;
  downloadProgress: number;
  totalCommits: number | null;
  lastDownloadedSha: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  downloadStartedAt: Date | null;
  downloadCompletedAt: Date | null;
}

export interface CreatePreSavedRangeRequest {
  name: string;
  gitilesUrl: string;
}

export interface DownloadProgressUpdate {
  rangeId: string;
  status: DownloadStatus;
  progress: number;
  total: number | null;
  error: string | null;
}

// ============================================================================
// LLM Call Types (for debug page)
// ============================================================================

export type LlmCallType = 'query_classification' | 'ranking' | 'answer_synthesis' | 'other';

export interface LlmCall {
  id: string;
  runId: string;
  callType: LlmCallType;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: Date;
}

// ============================================================================
// Admin Debug Types
// ============================================================================

export interface AdminSessionSummary {
  id: string;
  rangeEnabled: boolean;
  startSha: string | null;
  endSha: string | null;
  pathScope: string[];
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  runCount: number;
}

export interface AdminSessionDetail {
  session: AdminSessionSummary;
  messages: AdminMessage[];
  runs: AdminRunDetail[];
}

export interface AdminMessage {
  id: string;
  role: string;
  content: string;
  runId: string | null;
  createdAt: Date;
}

export interface AdminRunDetail {
  id: string;
  queryHash: string;
  status: string;
  durationMs: number | null;
  toolCallCount: number;
  bytesUsed: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  llmCalls: LlmCall[];
}
