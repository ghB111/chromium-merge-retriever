import { useState, useCallback, useEffect } from 'react';
import { api, ApiError } from '../services/api';
import type { Session, SessionScope, Message } from '../types';

interface UseChatReturn {
  session: Session | null;
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  createSession: () => Promise<void>;
  updateScope: (scope: Partial<SessionScope> & { rangeUrl?: string }) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  clearMessages: () => Promise<void>;
  showDebug: boolean;
  setShowDebug: (show: boolean) => void;
}

export function useChat(): UseChatReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(true);

  // Auto-create session on mount or load existing session with messages
  useEffect(() => {
    const storedSessionId = localStorage.getItem('chromium-search-session');
    if (storedSessionId) {
      // Load existing session and its messages
      Promise.all([
        api.getSession(storedSessionId),
        api.getMessages(storedSessionId),
      ])
        .then(([session, { messages: apiMessages }]) => {
          setSession(session);
          // Convert API messages to frontend Message format
          const loadedMessages: Message[] = apiMessages.map((msg) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.createdAt),
          }));
          
          // Check if the session is in progress (last message is from user, meaning assistant response is pending)
          const lastMessage = loadedMessages[loadedMessages.length - 1];
          if (lastMessage && lastMessage.role === 'user') {
            // Add a loading placeholder for the pending assistant response
            const assistantPlaceholder: Message = {
              id: `assistant-pending-${Date.now()}`,
              role: 'assistant',
              content: '',
              timestamp: new Date(),
              isLoading: true,
            };
            setMessages([...loadedMessages, assistantPlaceholder]);
            setIsLoading(true);
          } else {
            setMessages(loadedMessages);
          }
        })
        .catch(() => {
          localStorage.removeItem('chromium-search-session');
          createSession();
        });
    } else {
      createSession();
    }
  }, []);

  const createSession = useCallback(async () => {
    setError(null);
    try {
      const newSession = await api.createSession();
      setSession(newSession);
      setMessages([]);
      localStorage.setItem('chromium-search-session', newSession.sessionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create session');
    }
  }, []);

  const updateScope = useCallback(async (
    scopeUpdate: Partial<SessionScope> & { rangeUrl?: string }
  ) => {
    if (!session) return;
    setError(null);
    try {
      // Convert null to undefined for API compatibility
      const apiScope: Parameters<typeof api.updateScope>[1] = {
        rangeEnabled: scopeUpdate.rangeEnabled,
        rangeUrl: scopeUpdate.rangeUrl,
        range: scopeUpdate.range ?? undefined,
        pathScope: scopeUpdate.pathScope,
      };
      const result = await api.updateScope(session.sessionId, apiScope);
      setSession(prev => prev ? { ...prev, scope: result.scope } : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update scope');
      throw err;
    }
  }, [session]);

  const sendMessage = useCallback(async (text: string) => {
    if (!session || isLoading) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    const assistantPlaceholder: Message = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isLoading: true,
    };

    setMessages(prev => [...prev, userMessage, assistantPlaceholder]);
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.sendMessage(session.sessionId, text, showDebug);
      
      setMessages(prev => prev.map(msg => 
        msg.id === assistantPlaceholder.id
          ? {
              ...msg,
              content: response.answer,
              evidence: response.evidence,
              debug: response.debug,
              isLoading: false,
            }
          : msg
      ));
    } catch (err) {
      setMessages(prev => prev.map(msg =>
        msg.id === assistantPlaceholder.id
          ? {
              ...msg,
              content: `Error: ${err instanceof ApiError ? err.message : 'Failed to get response'}`,
              isLoading: false,
            }
          : msg
      ));
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setIsLoading(false);
    }
  }, [session, isLoading, showDebug]);

  const clearMessages = useCallback(async () => {
    // Set session to null immediately to prevent sends during the transition.
    // This blocks sendMessage() since it checks `if (!session || isLoading) return;`
    setSession(null);
    setMessages([]);
    setIsLoading(false);
    await createSession();
  }, [createSession]);

  return {
    session,
    messages,
    isLoading,
    error,
    createSession,
    updateScope,
    sendMessage,
    clearMessages,
    showDebug,
    setShowDebug,
  };
}
