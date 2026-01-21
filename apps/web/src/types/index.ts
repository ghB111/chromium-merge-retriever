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
