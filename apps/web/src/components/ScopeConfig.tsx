import { useState } from 'react';
import { Settings, Link, FolderTree, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import type { SessionScope } from '../types';

interface ScopeConfigProps {
  scope: SessionScope | null;
  onUpdateScope: (scope: Partial<SessionScope> & { rangeUrl?: string }) => Promise<void>;
}

export function ScopeConfig({ scope, onUpdateScope }: ScopeConfigProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [rangeUrl, setRangeUrl] = useState('');
  const [pathScope, setPathScope] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSetRange = async () => {
    if (!rangeUrl.trim()) return;
    setIsUpdating(true);
    setError(null);
    try {
      await onUpdateScope({ rangeUrl: rangeUrl.trim() });
      setRangeUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set range');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAddPath = async () => {
    if (!pathScope.trim()) return;
    const currentPaths = scope?.pathScope || [];
    const newPath = pathScope.trim();
    if (currentPaths.includes(newPath)) {
      setPathScope('');
      return;
    }
    setIsUpdating(true);
    setError(null);
    try {
      await onUpdateScope({ pathScope: [...currentPaths, newPath] });
      setPathScope('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add path');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRemovePath = async (pathToRemove: string) => {
    const currentPaths = scope?.pathScope || [];
    setIsUpdating(true);
    try {
      await onUpdateScope({ pathScope: currentPaths.filter(p => p !== pathToRemove) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove path');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleClearRange = async () => {
    setIsUpdating(true);
    try {
      await onUpdateScope({ rangeEnabled: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear range');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="card mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 rounded-t-xl"
      >
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-gray-500" />
          <span className="font-medium text-gray-700">Search Scope</span>
          {scope?.range && (
            <span className="text-sm text-chromium-600 bg-chromium-50 px-2 py-0.5 rounded-full">
              Range configured
            </span>
          )}
        </div>
        {isExpanded ? (
          <ChevronUp className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        )}
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 border-t border-gray-100">
          {error && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Commit Range */}
          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
              <Link className="w-4 h-4" />
              Commit Range (Gitiles URL)
            </label>
            
            {scope?.range ? (
              <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                <Check className="w-5 h-5 text-green-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-green-800">Range configured</p>
                  <p className="text-xs text-green-600 truncate">
                    {scope.range.startSha.slice(0, 8)}..{scope.range.endSha.slice(0, 8)}
                  </p>
                </div>
                <button
                  onClick={handleClearRange}
                  disabled={isUpdating}
                  className="p-1 hover:bg-green-100 rounded text-green-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={rangeUrl}
                  onChange={(e) => setRangeUrl(e.target.value)}
                  placeholder="https://chromium.googlesource.com/chromium/src/+log/abc123..def456"
                  className="input flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleSetRange()}
                />
                <button
                  onClick={handleSetRange}
                  disabled={isUpdating || !rangeUrl.trim()}
                  className="btn btn-primary"
                >
                  Set
                </button>
              </div>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Paste a Gitiles log URL to analyze a specific commit range
            </p>
          </div>

          {/* Path Scope */}
          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
              <FolderTree className="w-4 h-4" />
              Path Scope (optional)
            </label>
            
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={pathScope}
                onChange={(e) => setPathScope(e.target.value)}
                placeholder="net/http/"
                className="input flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
              />
              <button
                onClick={handleAddPath}
                disabled={isUpdating || !pathScope.trim()}
                className="btn btn-secondary"
              >
                Add
              </button>
            </div>

            {scope?.pathScope && scope.pathScope.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {scope.pathScope.map((path) => (
                  <span
                    key={path}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-sm rounded-lg"
                  >
                    <code className="text-xs">{path}</code>
                    <button
                      onClick={() => handleRemovePath(path)}
                      disabled={isUpdating}
                      className="p-0.5 hover:bg-gray-200 rounded"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Limit search to specific directories (e.g., net/, base/)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
