import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface SessionIdDisplayProps {
  sessionId: string | null;
}

export function SessionIdDisplay({ sessionId }: SessionIdDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!sessionId) return;
    
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy session ID:', err);
    }
  };

  if (!sessionId) {
    return null;
  }

  // Show first 8 characters with ellipsis for brevity
  const displayId = `${sessionId.slice(0, 8)}...`;

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span className="text-gray-400">Session:</span>
      <code className="bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-600">
        {displayId}
      </code>
      <button
        onClick={handleCopy}
        className="p-1 hover:bg-gray-100 rounded transition-colors"
        title={copied ? 'Copied!' : 'Copy full session ID'}
        aria-label={copied ? 'Copied!' : 'Copy full session ID'}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-green-500" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600" />
        )}
      </button>
    </div>
  );
}
