import type { Session, SessionScope, ChatResponse } from '../types';

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

  // Health check
  async checkHealth(): Promise<{ status: string }> {
    const response = await fetch('/health');
    return handleResponse<{ status: string }>(response);
  },
};

export { ApiError };
