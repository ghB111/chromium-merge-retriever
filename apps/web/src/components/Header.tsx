import { GitBranch, RefreshCw } from 'lucide-react';

interface HeaderProps {
  onNewChat: () => void | Promise<void>;
}

export function Header({ onNewChat }: HeaderProps) {
  return (
    <header className="bg-white border-b border-gray-200 px-4 py-3">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-chromium-600 rounded-lg flex items-center justify-center">
            <GitBranch className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Chromium Search</h1>
            <p className="text-sm text-gray-500">AI-powered commit analysis</p>
          </div>
        </div>
        
        <button
          onClick={onNewChat}
          className="btn btn-secondary gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          New Chat
        </button>
      </div>
    </header>
  );
}
