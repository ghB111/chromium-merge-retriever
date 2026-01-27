// API Types

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
}

export interface Evidence {
  type: 'commit' | 'diff_excerpt' | 'file_excerpt';
  sha?: string;
  url?: string;
  whyRelevant?: string;
  file?: string;
  path?: string;
  excerpt?: string;
  truncated?: boolean;
  revision?: string;
}

export interface ToolCall {
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
  toolCalls: ToolCall[];
  rankedCandidates: RankedCandidate[];
}

export interface ChatResponse {
  answer: string;
  evidence: Evidence[];
  debug?: DebugInfo;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  evidence?: Evidence[];
  debug?: DebugInfo;
  timestamp: Date;
  isLoading?: boolean;
}

// Pre-saved range types
export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error';

export interface PreSavedRange {
  id: string;
  name: string;
  gitilesUrl: string;
  repoBaseUrl?: string;
  startSha: string;
  endSha: string;
  downloadStatus: DownloadStatus;
  downloadProgress: number;
  totalCommits: number | null;
  lastDownloadedSha?: string | null;
  errorMessage: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DownloadProgressUpdate {
  rangeId: string;
  status: DownloadStatus;
  progress: number;
  total: number | null;
  error: string | null;
}

// Admin Debug Types
export type LlmCallType = 'query_classification' | 'ranking' | 'answer_synthesis' | 'agent_exploration' | 'other';

export interface AgentToolCall {
  name: string;
  arguments: string;
  result: string;
}

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
  createdAt: string;
  // For agent_exploration calls, track the tool calls made
  toolCalls?: AgentToolCall[];
}

export interface AdminSessionSummary {
  id: string;
  rangeEnabled: boolean;
  startSha: string | null;
  endSha: string | null;
  pathScope: string[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  runCount: number;
}

export interface AdminMessage {
  id: string;
  role: string;
  content: string;
  runId: string | null;
  createdAt: string;
}

export interface AdminRunDetail {
  id: string;
  queryHash: string;
  status: string;
  durationMs: number | null;
  toolCallCount: number;
  bytesUsed: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  llmCalls: LlmCall[];
}

export interface AdminSessionDetail {
  session: AdminSessionSummary;
  messages: AdminMessage[];
  runs: AdminRunDetail[];
}
