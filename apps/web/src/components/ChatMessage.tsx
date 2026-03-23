import { User, Bot, ExternalLink, FileCode, GitCommit, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Message, Evidence } from '../types';

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const progressUpdates = message.progressUpdates ?? [];
  const latestProgressMessage =
    progressUpdates[progressUpdates.length - 1]?.message ?? 'Analyzing commits...';
  const recentProgressMessages = progressUpdates
    .slice(-5)
    .map(update => update.message);

  return (
    <div className={`flex gap-4 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser ? 'bg-chromium-600' : 'bg-gray-200'
      }`}>
        {isUser ? (
          <User className="w-5 h-5 text-white" />
        ) : (
          <Bot className="w-5 h-5 text-gray-600" />
        )}
      </div>

      {/* Message content */}
      <div className={`flex-1 max-w-3xl ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block text-left rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-chromium-600 text-white'
            : 'bg-white border border-gray-200 shadow-sm'
        }`}>
          {message.isLoading ? (
            <div>
              <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{latestProgressMessage}</span>
              </div>
              {recentProgressMessages.length > 1 && (
                <ul className="mt-2 space-y-1 text-xs text-gray-400">
                  {recentProgressMessages.slice(0, -1).map((progress, index) => (
                    <li key={`${progress}-${index}`} className="truncate">
                      • {progress}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className={`markdown-content ${isUser ? 'text-white' : ''}`}>
              <ReactMarkdown
                components={{
                  // Custom link rendering
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1 ${
                        isUser ? 'text-chromium-200 hover:text-white' : 'text-chromium-600 hover:text-chromium-700'
                      }`}
                    >
                      {children}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ),
                  // Custom code block rendering
                  code: ({ className, children }) => {
                    const isBlock = className?.includes('language-');
                    if (isBlock) {
                      return (
                        <pre className={`${isUser ? 'bg-chromium-700' : 'bg-gray-900'} rounded-lg p-3 overflow-x-auto`}>
                          <code className="text-sm">{children}</code>
                        </pre>
                      );
                    }
                    return (
                      <code className={`px-1 py-0.5 rounded text-sm ${
                        isUser ? 'bg-chromium-700' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* Evidence */}
        {message.evidence && message.evidence.length > 0 && (
          <div className="mt-3">
            <EvidenceList evidence={message.evidence} />
          </div>
        )}

        {/* Timestamp */}
        <div className={`mt-1 text-xs text-gray-400 ${isUser ? 'text-right' : ''}`}>
          {message.timestamp.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const commits = evidence.filter(e => e.type === 'commit');
  const diffs = evidence.filter(e => e.type === 'diff_excerpt');
  const files = evidence.filter(e => e.type === 'file_excerpt');

  return (
    <div className="space-y-2">
      {/* Commits */}
      {commits.length > 0 && (
        <div className="card p-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Related Commits ({commits.length})
          </h4>
          <div className="space-y-2">
            {commits.slice(0, 5).map((commit, i) => (
              <a
                key={i}
                href={commit.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 p-2 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <GitCommit className="w-4 h-4 text-chromium-600 flex-shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <code className="text-xs text-chromium-600 font-medium">
                    {commit.sha?.slice(0, 8)}
                  </code>
                  {commit.whyRelevant && (
                    <p className="text-sm text-gray-600 truncate">{commit.whyRelevant}</p>
                  )}
                </div>
                <ExternalLink className="w-3 h-3 text-gray-400 flex-shrink-0" />
              </a>
            ))}
            {commits.length > 5 && (
              <p className="text-xs text-gray-500 text-center">
                +{commits.length - 5} more commits
              </p>
            )}
          </div>
        </div>
      )}

      {/* Diffs */}
      {diffs.length > 0 && (
        <div className="card p-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Diff Excerpts ({diffs.length})
          </h4>
          <div className="space-y-2">
            {diffs.slice(0, 3).map((diff, i) => (
              <div key={i} className="p-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <FileCode className="w-4 h-4 text-gray-500" />
                  <code className="text-xs text-gray-600">{diff.file}</code>
                  <code className="text-xs text-gray-400">@ {diff.sha?.slice(0, 8)}</code>
                </div>
                {diff.excerpt && (
                  <pre className="text-xs bg-gray-900 text-gray-100 p-2 rounded overflow-x-auto max-h-32">
                    {diff.excerpt.slice(0, 500)}
                    {diff.truncated && '\n...'}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Files */}
      {files.length > 0 && (
        <div className="card p-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            File Excerpts ({files.length})
          </h4>
          <div className="space-y-2">
            {files.slice(0, 3).map((file, i) => (
              <div key={i} className="p-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <FileCode className="w-4 h-4 text-gray-500" />
                  <code className="text-xs text-gray-600">{file.path}</code>
                  <code className="text-xs text-gray-400">@ {file.revision?.slice(0, 8)}</code>
                </div>
                {file.excerpt && (
                  <pre className="text-xs bg-gray-900 text-gray-100 p-2 rounded overflow-x-auto max-h-32">
                    {file.excerpt.slice(0, 500)}
                    {file.truncated && '\n...'}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
