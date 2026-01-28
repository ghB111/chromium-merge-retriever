import { useRef, useEffect } from 'react';
import { Header, ScopeConfig, ChatMessage, ChatInput, SessionIdDisplay } from './components';
import { useChat } from './hooks/useChat';
import { MessageSquare, AlertCircle, Bug } from 'lucide-react';

function App() {
  const {
    session,
    messages,
    isLoading,
    error,
    updateScope,
    sendMessage,
    clearMessages,
    showDebug,
    setShowDebug,
  } = useChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <Header onNewChat={clearMessages} />

      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-6">
            {/* Scope Configuration */}
            <ScopeConfig
              scope={session?.scope || null}
              onUpdateScope={updateScope}
            />

            {/* Error Banner */}
            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Session ID and Debug Toggle */}
            <div className="mb-4 flex items-center justify-between">
              <SessionIdDisplay sessionId={session?.sessionId || null} />
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                  className="rounded border-gray-300 text-chromium-600 focus:ring-chromium-500"
                />
                <Bug className="w-4 h-4" />
                Show debug info
              </label>
            </div>

            {/* Messages */}
            {messages.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="space-y-6">
                {messages.map((message) => (
                  <ChatMessage key={message.id} message={message} />
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input */}
        <ChatInput
          onSend={sendMessage}
          isLoading={isLoading}
          disabled={!session}
          placeholder={
            !session?.scope?.range
              ? "Set a commit range above, then ask your question..."
              : "Ask about Chromium changes..."
          }
        />
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-12">
      <div className="w-16 h-16 bg-chromium-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <MessageSquare className="w-8 h-8 text-chromium-600" />
      </div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">
        Start a conversation
      </h2>
      <p className="text-gray-500 max-w-md mx-auto mb-6">
        Ask questions about Chromium commits, investigate regressions, or explore what changed in a specific range.
      </p>
      <div className="max-w-lg mx-auto text-left">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Example questions:</h3>
        <ul className="space-y-2 text-sm text-gray-600">
          <li className="flex items-start gap-2">
            <span className="text-chromium-500">•</span>
            <span>What changes were made to the network stack in this range?</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-chromium-500">•</span>
            <span>Which commits modified net/http/ files?</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-chromium-500">•</span>
            <span>What could have caused test failures in the HTTP module?</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-chromium-500">•</span>
            <span>Show me changes to class HttpCache</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

export default App;
