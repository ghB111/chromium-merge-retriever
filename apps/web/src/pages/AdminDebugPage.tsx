import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Shield,
  ArrowLeft,
  RefreshCw,
  Trash2,
  AlertCircle,
  Loader2,
  MessageSquare,
  Bot,
  User,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../services/api';
import type { AdminSessionSummary, AdminSessionDetail, AdminMessage, AdminRunDetail, LlmCall } from '../types';

export default function AdminDebugPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Check if admin session exists on mount
  useEffect(() => {
    const storedAuth = sessionStorage.getItem('adminAuth');
    if (storedAuth) {
      api.setAdminPassword(storedAuth);
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthenticating(true);
    setAuthError(null);

    try {
      const success = await api.adminLogin(password);
      if (success) {
        sessionStorage.setItem('adminAuth', password);
        setIsAuthenticated(true);
      } else {
        setAuthError('Invalid password');
      }
    } catch (err) {
      setAuthError('Authentication failed');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleLogout = () => {
    api.clearAdminPassword();
    sessionStorage.removeItem('adminAuth');
    setIsAuthenticated(false);
  };

  // Login screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full">
          <div className="card p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-chromium-100 rounded-full flex items-center justify-center">
                <Shield className="w-6 h-6 text-chromium-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Debug Console</h1>
                <p className="text-sm text-gray-500">Enter admin password to continue</p>
              </div>
            </div>

            <form onSubmit={handleLogin}>
              {authError && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {authError}
                </div>
              )}

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input w-full"
                  placeholder="Enter admin password"
                  autoFocus
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="btn btn-secondary flex-1"
                >
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back
                </button>
                <button
                  type="submit"
                  disabled={isAuthenticating || !password}
                  className="btn btn-primary flex-1"
                >
                  {isAuthenticating ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  Login
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900">Debug Console</h1>
              <p className="text-xs text-gray-500">View dialogs and LLM interactions</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/admin')}
              className="btn btn-secondary text-sm"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Admin Panel
            </button>
            <button onClick={handleLogout} className="btn btn-secondary text-sm">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {sessionId ? (
          <SessionDetailView sessionId={sessionId} onBack={() => navigate('/admin/debug')} />
        ) : (
          <SessionListView onSelectSession={(id) => navigate(`/admin/debug/${id}`)} />
        )}
      </main>
    </div>
  );
}

// Session List View
interface SessionListViewProps {
  onSelectSession: (sessionId: string) => void;
}

function SessionListView({ onSelectSession }: SessionListViewProps) {
  const [sessions, setSessions] = useState<AdminSessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { sessions } = await api.getAdminSessions();
      setSessions(sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Are you sure you want to delete this session? This will delete all messages and LLM call history.')) return;

    try {
      await api.deleteAdminSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete session');
    }
  };

  return (
    <div className="card">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">All Sessions</h2>
        <button
          onClick={loadSessions}
          disabled={isLoading}
          className="btn btn-secondary text-sm"
        >
          <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {isLoading && sessions.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          Loading sessions...
        </div>
      ) : sessions.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          No sessions found.
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="p-4 hover:bg-gray-50 cursor-pointer transition-colors"
              onClick={() => onSelectSession(session.id)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm text-gray-900">{session.id.slice(0, 8)}...</span>
                    <span className="text-xs text-gray-500">
                      {new Date(session.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-gray-600">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-4 h-4" />
                      {session.messageCount} messages
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="w-4 h-4" />
                      {session.runCount} runs
                    </span>
                  </div>
                  {session.startSha && session.endSha && (
                    <div className="mt-1 text-xs text-gray-500">
                      Range: {session.startSha.slice(0, 8)}..{session.endSha.slice(0, 8)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ChevronRight className="w-5 h-5 text-gray-400" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(session.id);
                    }}
                    className="btn btn-secondary text-sm text-red-600 hover:bg-red-50 p-2"
                    title="Delete session"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Session Detail View
interface SessionDetailViewProps {
  sessionId: string;
  onBack: () => void;
}

function SessionDetailView({ sessionId, onBack }: SessionDetailViewProps) {
  const [detail, setDetail] = useState<AdminSessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [expandedLlmCalls, setExpandedLlmCalls] = useState<Set<string>>(new Set());

  const loadDetail = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await api.getAdminSessionDetail(sessionId);
      setDetail(result);
      // Auto-expand all runs by default
      setExpandedRuns(new Set(result.runs.map(r => r.id)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load session detail');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDetail();
  }, [sessionId]);

  const toggleRun = (runId: string) => {
    setExpandedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const toggleLlmCall = (callId: string) => {
    setExpandedLlmCalls(prev => {
      const next = new Set(prev);
      if (next.has(callId)) {
        next.delete(callId);
      } else {
        next.add(callId);
      }
      return next;
    });
  };

  // Group messages by runId for display
  const getRunForMessage = (message: AdminMessage): AdminRunDetail | undefined => {
    if (!detail) return undefined;
    return detail.runs.find(r => r.id === message.runId);
  };

  if (isLoading) {
    return (
      <div className="card p-8 text-center text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
        Loading session detail...
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-4">
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
        <button onClick={onBack} className="btn btn-secondary">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Sessions
        </button>
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="btn btn-secondary">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Sessions
        </button>
        <button onClick={loadDetail} disabled={isLoading} className="btn btn-secondary">
          <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Session Info */}
      <div className="card p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Session Info</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">ID:</span>
            <span className="ml-2 font-mono">{detail.session.id.slice(0, 12)}...</span>
          </div>
          <div>
            <span className="text-gray-500">Created:</span>
            <span className="ml-2">{new Date(detail.session.createdAt).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-gray-500">Messages:</span>
            <span className="ml-2">{detail.session.messageCount}</span>
          </div>
          <div>
            <span className="text-gray-500">Runs:</span>
            <span className="ml-2">{detail.session.runCount}</span>
          </div>
          {detail.session.startSha && detail.session.endSha && (
            <div className="col-span-2">
              <span className="text-gray-500">Range:</span>
              <span className="ml-2 font-mono">{detail.session.startSha.slice(0, 8)}..{detail.session.endSha.slice(0, 8)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Dialog View */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Dialog & LLM Interactions</h2>
          <p className="text-xs text-gray-500 mt-1">Messages shown with their associated LLM calls</p>
        </div>

        <div className="divide-y divide-gray-100">
          {detail.messages.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No messages in this session.
            </div>
          ) : (
            detail.messages.map((message) => {
              const run = getRunForMessage(message);
              const isUser = message.role === 'user';
              const showRunDetails = !isUser && run && run.llmCalls.length > 0;

              return (
                <div key={message.id} className="p-4">
                  {/* Message */}
                  <div className={`flex gap-3 ${isUser ? '' : 'bg-gray-50 -mx-4 px-4 py-4'}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      isUser ? 'bg-blue-100' : 'bg-purple-100'
                    }`}>
                      {isUser ? (
                        <User className="w-4 h-4 text-blue-600" />
                      ) : (
                        <Bot className="w-4 h-4 text-purple-600" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`font-medium text-sm ${isUser ? 'text-blue-700' : 'text-purple-700'}`}>
                          {isUser ? 'User' : 'Assistant'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(message.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                        {message.content}
                      </div>
                    </div>
                  </div>

                  {/* Run Details (LLM Calls) */}
                  {showRunDetails && (
                    <div className="mt-4 ml-11">
                      <button
                        onClick={() => toggleRun(run.id)}
                        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
                      >
                        {expandedRuns.has(run.id) ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        <Cpu className="w-4 h-4" />
                        <span>Run Details</span>
                        <span className="text-xs text-gray-400">
                          ({run.llmCalls.length} LLM calls, {run.durationMs}ms)
                        </span>
                      </button>

                      {expandedRuns.has(run.id) && (
                        <div className="mt-3 space-y-3">
                          {/* Run Stats */}
                          <div className="flex items-center gap-4 text-xs text-gray-500 pl-6">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {run.durationMs}ms
                            </span>
                            <span className="flex items-center gap-1">
                              <Zap className="w-3 h-3" />
                              {run.toolCallCount} tool calls
                            </span>
                            <span className="flex items-center gap-1">
                              <FileText className="w-3 h-3" />
                              {(run.bytesUsed / 1024).toFixed(1)}KB
                            </span>
                            <span className={`px-2 py-0.5 rounded text-xs ${
                              run.status === 'completed' ? 'bg-green-100 text-green-700' :
                              run.status === 'failed' ? 'bg-red-100 text-red-700' :
                              'bg-yellow-100 text-yellow-700'
                            }`}>
                              {run.status}
                            </span>
                          </div>

                          {/* LLM Calls */}
                          {run.llmCalls.map((call) => (
                            <LlmCallCard
                              key={call.id}
                              call={call}
                              isExpanded={expandedLlmCalls.has(call.id)}
                              onToggle={() => toggleLlmCall(call.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// LLM Call Card
interface LlmCallCardProps {
  call: LlmCall;
  isExpanded: boolean;
  onToggle: () => void;
}

function LlmCallCard({ call, isExpanded, onToggle }: LlmCallCardProps) {
  const callTypeLabels: Record<string, string> = {
    query_classification: 'Query Classification',
    ranking: 'Commit Ranking',
    answer_synthesis: 'Answer Synthesis',
    other: 'Other',
  };

  const callTypeColors: Record<string, string> = {
    query_classification: 'bg-blue-100 text-blue-700',
    ranking: 'bg-orange-100 text-orange-700',
    answer_synthesis: 'bg-green-100 text-green-700',
    other: 'bg-gray-100 text-gray-700',
  };

  return (
    <div className="ml-6 border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
          <span className={`px-2 py-0.5 rounded text-xs ${callTypeColors[call.callType] || callTypeColors.other}`}>
            {callTypeLabels[call.callType] || call.callType}
          </span>
          <span className="text-sm text-gray-600">{call.model}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span>{call.inputTokens} in / {call.outputTokens} out tokens</span>
          <span>{call.latencyMs}ms</span>
        </div>
      </button>

      {isExpanded && (
        <div className="p-4 space-y-4 bg-white">
          {/* System Prompt */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">System Prompt</h4>
            <div className="bg-gray-50 rounded p-3 text-sm text-gray-700 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
              {call.systemPrompt}
            </div>
          </div>

          {/* User Prompt */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">User Prompt</h4>
            <div className="bg-blue-50 rounded p-3 text-sm text-gray-700 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
              {call.userPrompt}
            </div>
          </div>

          {/* Response */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">LLM Response</h4>
            <div className="bg-green-50 rounded p-3 text-sm text-gray-700 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
              {call.response}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
