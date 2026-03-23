import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../services/api';
import type { Session, SessionScope, Message, ProgressUpdate } from '../types';

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

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60;

export function useChat(urlSessionId?: string): UseChatReturn {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollForAssistantReply = useCallback((sessionId: string, placeholderId: string, expectedCount: number) => {
    let attempts = 0;

    const tick = async () => {
      attempts++;
      try {
        const { messages: apiMessages } = await api.getMessages(sessionId);
        if (apiMessages.length > expectedCount) {
          const last = apiMessages[apiMessages.length - 1];
          if (last.role === 'assistant') {
            stopPolling();
            setMessages(prev => prev.map(msg =>
              msg.id === placeholderId
                ? {
                    ...msg,
                    id: last.id,
                    content: last.content,
                    evidence: last.evidence ?? undefined,
                    timestamp: new Date(last.createdAt),
                    isLoading: false,
                  }
                : msg
            ));
            setIsLoading(false);
            return;
          }
        }
      } catch {
        // network hiccup – keep trying
      }

      if (attempts >= POLL_MAX_ATTEMPTS) {
        stopPolling();
        setMessages(prev => prev.map(msg =>
          msg.id === placeholderId
            ? { ...msg, content: 'The assistant response is taking too long. Please try again.', isLoading: false }
            : msg
        ));
        setIsLoading(false);
        return;
      }

      pollRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };

    pollRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [stopPolling]);

  // Helper function to load session and messages
  const loadSession = useCallback(async (sessionId: string, updateUrl: boolean = false) => {
    try {
      const [sessionData, { messages: apiMessages }] = await Promise.all([
        api.getSession(sessionId),
        api.getMessages(sessionId),
      ]);
      
      setSession(sessionData);
      localStorage.setItem('chromium-search-session', sessionId);
      
      // Update URL if needed (e.g., when loading from localStorage)
      if (updateUrl) {
        navigate(`/chat/${sessionId}`, { replace: true });
      }
      
      // Convert API messages to frontend Message format
      const loadedMessages: Message[] = apiMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        evidence: msg.evidence ?? undefined,
        timestamp: new Date(msg.createdAt),
      }));
      
      // Check if the session is in progress (last message is from user, meaning assistant response is pending)
      const lastMessage = loadedMessages[loadedMessages.length - 1];
      if (lastMessage && lastMessage.role === 'user') {
        const placeholderId = `assistant-pending-${Date.now()}`;
        const assistantPlaceholder: Message = {
          id: placeholderId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          isLoading: true,
          progressUpdates: [{ stage: 'starting', message: 'Waiting for response...', timestamp: new Date().toISOString() }],
        };
        setMessages([...loadedMessages, assistantPlaceholder]);
        setIsLoading(true);
        pollForAssistantReply(sessionId, placeholderId, apiMessages.length);
      } else {
        setMessages(loadedMessages);
      }
      
      return true;
    } catch {
      return false;
    }
  }, [navigate, pollForAssistantReply]);

  // Auto-create session on mount or load existing session with messages
  useEffect(() => {
    const initSession = async () => {
      // Priority 1: URL session ID
      if (urlSessionId) {
        const loaded = await loadSession(urlSessionId, false);
        if (loaded) return;
        // If URL session ID is invalid, clear it and create new session
        navigate('/', { replace: true });
      }
      
      // Priority 2: localStorage session ID (only if no URL session)
      if (!urlSessionId) {
        const storedSessionId = localStorage.getItem('chromium-search-session');
        if (storedSessionId) {
          const loaded = await loadSession(storedSessionId, true);
          if (loaded) return;
          // If stored session is invalid, clear it
          localStorage.removeItem('chromium-search-session');
        }
      }
      
      // Priority 3: Create new session
      await createNewSession();
    };
    
    initSession();
  }, [urlSessionId]); // Only re-run when URL session ID changes

  const createNewSession = useCallback(async () => {
    setError(null);
    try {
      const newSession = await api.createSession();
      setSession(newSession);
      setMessages([]);
      localStorage.setItem('chromium-search-session', newSession.sessionId);
      navigate(`/chat/${newSession.sessionId}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create session');
    }
  }, [navigate]);

  // Keep createSession as alias for external use
  const createSession = createNewSession;

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
      progressUpdates: [],
    };

    setMessages(prev => [...prev, userMessage, assistantPlaceholder]);
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.sendMessageStream(
        session.sessionId,
        text,
        showDebug,
        (progress: ProgressUpdate) => {
          setMessages(prev => prev.map(msg => {
            if (msg.id !== assistantPlaceholder.id) {
              return msg;
            }

            const currentUpdates = msg.progressUpdates ?? [];
            const lastUpdate = currentUpdates[currentUpdates.length - 1];
            if (
              lastUpdate &&
              lastUpdate.stage === progress.stage &&
              lastUpdate.message === progress.message
            ) {
              return msg;
            }

            return {
              ...msg,
              progressUpdates: [...currentUpdates, progress],
            };
          }));
        }
      );
      
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
    stopPolling();
    // Set session to null immediately to prevent sends during the transition.
    // This blocks sendMessage() since it checks `if (!session || isLoading) return;`
    setSession(null);
    setMessages([]);
    setIsLoading(false);
    await createNewSession();
  }, [createNewSession, stopPolling]);

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
