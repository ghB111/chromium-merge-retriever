import type { Session, SessionScope, ChatResponse, PreSavedRange, DownloadProgressUpdate } from '../types';

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
};

export { ApiError };
