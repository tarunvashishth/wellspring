const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export function setToken(token: string) {
  localStorage.setItem('token', token);
}

export function clearToken() {
  localStorage.removeItem('token');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? 'Request failed'), { status: res.status, body });
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// Auth
export const auth = {
  signup: (data: { email: string; password: string; displayName: string }) =>
    request<{ token: string; creator: Creator }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  login: (data: { email: string; password: string }) =>
    request<{ token: string; creator: Creator }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
};

// Programs
export const programs = {
  list: () => request<Program[]>('/programs'),
  get: (id: string) => request<Program>(`/programs/${id}`),
  create: (data: { title: string; description?: string; tags: string[] }) =>
    request<Program>('/programs', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<{ title: string; description: string; tags: string[] }>) =>
    request<Program>(`/programs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/programs/${id}`, { method: 'DELETE' }),
};

// Sessions
export const sessions = {
  list: (programId: string) => request<Session[]>(`/programs/${programId}/sessions`),
  create: (programId: string, data: { title: string; description?: string; durationSeconds: number }) =>
    request<Session>(`/programs/${programId}/sessions`, { method: 'POST', body: JSON.stringify(data) }),
  update: (programId: string, id: string, data: Partial<{ title: string; durationSeconds: number }>) =>
    request<Session>(`/programs/${programId}/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (programId: string, id: string) =>
    request(`/programs/${programId}/sessions/${id}`, { method: 'DELETE' }),
  reorder: (programId: string, orderedIds: string[]) =>
    request<Session[]>(`/programs/${programId}/sessions/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
};

// Uploads
export const uploads = {
  initiate: (data: { sessionId: string; contentType: string; filename: string }) =>
    request<{ uploadUrl: string; fields: Record<string, string>; uploadKey: string }>('/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  complete: (data: { sessionId: string; uploadKey: string }) =>
    request<{ sessionId: string; mediaStatus: string }>('/uploads/complete', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Audit
export const audit = {
  list: (params: Record<string, string>) =>
    request<{ items: AuditLog[]; nextCursor: string | null }>(
      `/audit?${new URLSearchParams(params)}`,
    ),
};

// Types
export interface Creator {
  id: string;
  email: string;
  displayName: string;
}

export interface Program {
  id: string;
  creatorId: string;
  title: string;
  description?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  programId: string;
  title: string;
  description?: string;
  durationSeconds: number;
  position: number;
  mediaKey?: string;
  mediaStatus: 'PENDING' | 'PROCESSING' | 'VERIFIED' | 'FAILED';
  createdAt: string;
}

export interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  severity: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
