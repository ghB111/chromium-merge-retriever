import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield,
  Plus,
  Trash2,
  Download,
  XCircle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowLeft,
  RefreshCw,
  Link as LinkIcon,
  Bug,
} from 'lucide-react';
import { api, ApiError } from '../services/api';
import type { PreSavedRange, DownloadProgressUpdate } from '../types';

export default function AdminPanel() {
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const [ranges, setRanges] = useState<PreSavedRange[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [newRangeName, setNewRangeName] = useState('');
  const [newRangeUrl, setNewRangeUrl] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Progress tracking
  const [progressUpdates, setProgressUpdates] = useState<Map<string, DownloadProgressUpdate>>(new Map());

  // Check if admin session exists on mount
  useEffect(() => {
    const storedAuth = sessionStorage.getItem('adminAuth');
    if (storedAuth) {
      api.setAdminPassword(storedAuth);
      setIsAuthenticated(true);
    }
  }, []);

  // Load ranges when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadRanges();
    }
  }, [isAuthenticated]);

  // Poll for progress updates on downloading ranges
  useEffect(() => {
    if (!isAuthenticated) return;

    const downloadingRanges = ranges.filter(r => r.downloadStatus === 'downloading');
    const intervals: NodeJS.Timeout[] = [];

    for (const range of downloadingRanges) {
      const interval = setInterval(async () => {
        try {
          const { progress } = await api.getDownloadProgress(range.id);
          setProgressUpdates(prev => new Map(prev).set(range.id, progress));
          
          // Reload ranges if download completed or errored
          if (progress.status === 'completed' || progress.status === 'error') {
            loadRanges();
          }
        } catch (error) {
          console.error('Failed to get progress:', error);
        }
      }, 2000);
      intervals.push(interval);
    }

    return () => {
      intervals.forEach(clearInterval);
    };
  }, [ranges, isAuthenticated]);

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
    setRanges([]);
  };

  const loadRanges = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { ranges } = await api.getAdminRanges();
      setRanges(ranges);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load ranges');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateRange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRangeName.trim() || !newRangeUrl.trim()) return;

    setIsCreating(true);
    setCreateError(null);

    try {
      await api.createAdminRange(newRangeName.trim(), newRangeUrl.trim());
      setNewRangeName('');
      setNewRangeUrl('');
      loadRanges();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create range');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteRange = async (rangeId: string) => {
    if (!confirm('Are you sure you want to delete this range?')) return;

    try {
      await api.deleteAdminRange(rangeId);
      setRanges(prev => prev.filter(r => r.id !== rangeId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete range');
    }
  };

  const handleStartDownload = async (rangeId: string) => {
    try {
      await api.startDownload(rangeId);
      // Update local state to show downloading status
      setRanges(prev => prev.map(r => 
        r.id === rangeId ? { ...r, downloadStatus: 'downloading' as const } : r
      ));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start download');
    }
  };

  const handleCancelDownload = async (rangeId: string) => {
    try {
      await api.cancelDownload(rangeId);
      loadRanges();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel download');
    }
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
                <h1 className="text-xl font-bold text-gray-900">Admin Panel</h1>
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

  // Admin dashboard
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-chromium-100 rounded-full flex items-center justify-center">
              <Shield className="w-5 h-5 text-chromium-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900">Admin Panel</h1>
              <p className="text-xs text-gray-500">Manage pre-saved commit ranges</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/admin/debug')}
              className="btn btn-secondary text-sm"
            >
              <Bug className="w-4 h-4 mr-1" />
              Debug Console
            </button>
            <button
              onClick={() => navigate('/')}
              className="btn btn-secondary text-sm"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back to App
            </button>
            <button onClick={handleLogout} className="btn btn-secondary text-sm">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* Add New Range Form */}
        <div className="card mb-6">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Add New Range</h2>
          </div>
          <form onSubmit={handleCreateRange} className="p-4">
            {createError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {createError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={newRangeName}
                  onChange={(e) => setNewRangeName(e.target.value)}
                  className="input w-full"
                  placeholder="e.g., M120 to M121"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Gitiles URL
                </label>
                <input
                  type="text"
                  value={newRangeUrl}
                  onChange={(e) => setNewRangeUrl(e.target.value)}
                  className="input w-full"
                  placeholder="https://chromium.googlesource.com/chromium/src/+log/..."
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isCreating || !newRangeName.trim() || !newRangeUrl.trim()}
              className="btn btn-primary"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Add Range
            </button>
          </form>
        </div>

        {/* Ranges List */}
        <div className="card">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Pre-saved Ranges</h2>
            <button
              onClick={loadRanges}
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

          {isLoading && ranges.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
              Loading ranges...
            </div>
          ) : ranges.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <LinkIcon className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              No pre-saved ranges yet. Add one above.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {ranges.map((range) => (
                <RangeItem
                  key={range.id}
                  range={range}
                  progress={progressUpdates.get(range.id)}
                  onDelete={() => handleDeleteRange(range.id)}
                  onStartDownload={() => handleStartDownload(range.id)}
                  onCancelDownload={() => handleCancelDownload(range.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

interface RangeItemProps {
  range: PreSavedRange;
  progress?: DownloadProgressUpdate;
  onDelete: () => void;
  onStartDownload: () => void;
  onCancelDownload: () => void;
}

function RangeItem({ range, progress, onDelete, onStartDownload, onCancelDownload }: RangeItemProps) {
  const status = progress?.status || range.downloadStatus;
  const currentProgress = progress?.progress ?? range.downloadProgress;
  const total = progress?.total ?? range.totalCommits;
  const error = progress?.error ?? range.errorMessage;

  const progressPercent = total ? Math.round((currentProgress / total) * 100) : 0;

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-gray-900">{range.name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-sm text-gray-500 truncate mb-2">
            {range.startSha.slice(0, 8)}..{range.endSha.slice(0, 8)}
          </p>
          <a
            href={range.gitilesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-chromium-600 hover:text-chromium-700 hover:underline truncate block"
          >
            {range.gitilesUrl}
          </a>
        </div>

        <div className="flex items-center gap-2">
          {status === 'downloading' ? (
            <button
              onClick={onCancelDownload}
              className="btn btn-secondary text-sm"
              title="Cancel download"
            >
              <XCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onStartDownload}
              className="btn btn-primary text-sm"
              title={status === 'error' ? 'Resume download' : 'Start download'}
            >
              <Download className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onDelete}
            className="btn btn-secondary text-sm text-red-600 hover:bg-red-50"
            title="Delete range"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {(status === 'downloading' || status === 'completed' || (status === 'error' && currentProgress > 0)) && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>
              {currentProgress.toLocaleString()} / {total?.toLocaleString() || '?'} commits
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                status === 'completed'
                  ? 'bg-green-500'
                  : status === 'error'
                  ? 'bg-red-500'
                  : 'bg-chromium-500'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {status === 'error' && error && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-600">
          {error}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs">
          <CheckCircle2 className="w-3 h-3" />
          Completed
        </span>
      );
    case 'downloading':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs">
          <Loader2 className="w-3 h-3 animate-spin" />
          Downloading
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs">
          <AlertCircle className="w-3 h-3" />
          Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
          Pending
        </span>
      );
  }
}
