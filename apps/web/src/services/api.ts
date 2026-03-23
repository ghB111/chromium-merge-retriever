import type {
  Session,
  SessionScope,
  ChatResponse,
  PreSavedRange,
  DownloadProgressUpdate,
  AdminSessionSummary,
  AdminSessionDetail,
  Evidence,
  ProgressUpdate,
} from '../types';

const API_BASE = '/v1';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ChatStreamEvent =
  | { type: 'progress'; progress: ProgressUpdate }
  | { type: 'result'; response: ChatResponse }
  | { type: 'error'; error: { message: string; code?: string; status?: number } };

function parseChatStreamEvent(line: string): ChatStreamEvent | null {
  try {
    const parsed = JSON.parse(line) as ChatStreamEvent;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.error?.message || `HTTP ${response.status}`,
      response.status,
      error.error?.code
    );
  }
  return response.json();
}

// Store admin password for subsequent requests
let adminPassword: string | null = null;

function getAdminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminPassword) {
    headers['Authorization'] = `Bearer ${adminPassword}`;
  }
  return headers;
}

export const api = {
  // Session management
  async createSession(): Promise<Session> {
    const response = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return handleResponse<Session>(response);
  },

  async getSession(sessionId: string): Promise<Session> {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}`);
    return handleResponse<Session>(response);
  },

  async updateScope(
    sessionId: string,
    scope: {
      rangeEnabled?: boolean;
      rangeUrl?: string;
      range?: { startSha: string; endSha: string };
      pathScope?: string[];
    }
  ): Promise<{ scope: SessionScope }> {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
    });
    return handleResponse<{ scope: SessionScope }>(response);
  },

  // Chat
  async sendMessage(
    sessionId: string,
    text: string,
    includeDebug = false
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(includeDebug && { 'X-Include-Debug': 'true' }),
      },
      body: JSON.stringify({ text }),
    });
    return handleResponse<ChatResponse>(response);
  },

  async sendMessageStream(
    sessionId: string,
    text: string,
    includeDebug = false,
    onProgress?: (progress: ProgressUpdate) => void
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        ...(includeDebug && { 'X-Include-Debug': 'true' }),
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.error?.message || `HTTP ${response.status}`,
        response.status,
        error.error?.code
      );
    }

    if (!response.body) {
      throw new ApiError('Streaming response is not available in this browser.', 500);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: ChatResponse | null = null;

    const processLine = (line: string): void => {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        return;
      }

      const event = parseChatStreamEvent(trimmedLine);
      if (!event) {
        return;
      }

      switch (event.type) {
        case 'progress':
          onProgress?.(event.progress);
          break;
        case 'result':
          finalResponse = event.response;
          break;
        case 'error':
          throw new ApiError(
            event.error.message,
            event.error.status ?? 500,
            event.error.code
          );
      }
    };

    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        buffer += decoder.decode();
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    const trailingLine = buffer.trim();
    if (trailingLine.length > 0) {
      processLine(trailingLine);
    }

    if (!finalResponse) {
      throw new ApiError('Stream ended before delivering a response.', 500);
    }

    return finalResponse;
  },

  // Get messages for a session
  async getMessages(sessionId: string): Promise<{ messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; evidence: Evidence[] | null; createdAt: string }> }> {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/messages`);
    return handleResponse<{ messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; evidence: Evidence[] | null; createdAt: string }> }>(response);
  },

  // Health check
  async checkHealth(): Promise<{ status: string }> {
    const response = await fetch('/health');
    return handleResponse<{ status: string }>(response);
  },

  // =========================================================================
  // Public Range API (for user selection)
  // =========================================================================

  async getPublicRanges(): Promise<{ ranges: PreSavedRange[] }> {
    const response = await fetch(`${API_BASE}/ranges`);
    return handleResponse<{ ranges: PreSavedRange[] }>(response);
  },

  // =========================================================================
  // Admin API (password protected)
  // =========================================================================

  setAdminPassword(password: string): void {
    adminPassword = password;
  },

  clearAdminPassword(): void {
    adminPassword = null;
  },

  async adminLogin(password: string): Promise<boolean> {
    adminPassword = password;
    try {
      const response = await fetch(`${API_BASE}/admin/ranges`, {
        headers: getAdminHeaders(),
      });
      if (!response.ok) {
        adminPassword = null;
        return false;
      }
      return true;
    } catch {
      adminPassword = null;
      return false;
    }
  },

  async getAdminRanges(): Promise<{ ranges: PreSavedRange[] }> {
    const response = await fetch(`${API_BASE}/admin/ranges`, {
      headers: getAdminHeaders(),
    });
    return handleResponse<{ ranges: PreSavedRange[] }>(response);
  },

  async createAdminRange(name: string, gitilesUrl: string): Promise<{ range: PreSavedRange }> {
    const response = await fetch(`${API_BASE}/admin/ranges`, {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ name, gitilesUrl }),
    });
    return handleResponse<{ range: PreSavedRange }>(response);
  },

  async deleteAdminRange(rangeId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/admin/ranges/${rangeId}`, {
      method: 'DELETE',
      headers: getAdminHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.error?.message || `HTTP ${response.status}`,
        response.status,
        error.error?.code
      );
    }
  },

  async startDownload(rangeId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/admin/ranges/${rangeId}/download`, {
      method: 'POST',
      headers: getAdminHeaders(),
    });
    return handleResponse<void>(response);
  },

  async cancelDownload(rangeId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/admin/ranges/${rangeId}/download`, {
      method: 'DELETE',
      headers: getAdminHeaders(),
    });
    return handleResponse<void>(response);
  },

  async getDownloadProgress(rangeId: string): Promise<{ progress: DownloadProgressUpdate }> {
    const response = await fetch(`${API_BASE}/admin/ranges/${rangeId}/progress`, {
      headers: getAdminHeaders(),
    });
    return handleResponse<{ progress: DownloadProgressUpdate }>(response);
  },

  // =========================================================================
  // Admin Debug API
  // =========================================================================

  async getAdminSessions(): Promise<{ sessions: AdminSessionSummary[] }> {
    const response = await fetch(`${API_BASE}/admin/sessions`, {
      headers: getAdminHeaders(),
    });
    return handleResponse<{ sessions: AdminSessionSummary[] }>(response);
  },

  async getAdminSessionDetail(sessionId: string): Promise<AdminSessionDetail> {
    const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, {
      headers: getAdminHeaders(),
    });
    return handleResponse<AdminSessionDetail>(response);
  },

  async deleteAdminSession(sessionId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: getAdminHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.error?.message || `HTTP ${response.status}`,
        response.status,
        error.error?.code
      );
    }
  },
};

export { ApiError };
