export interface NodeDto {
  id: string;
  parentId: string | null;
  type: 'file' | 'folder';
  name: string;
  size: number;
  mime: string | null;
  encrypted: boolean;
  encryptByDefault: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface Crumb {
  id: string;
  name: string;
}

export interface Usage {
  limit: number;
  used: number;
  free: number;
  uploadable: number;
  accounts: { total: number; healthy: number; degraded: number };
  note: string;
}

export interface AccountView {
  id: string;
  email: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'DRAINING';
  quotaLimit: number;
  quotaUsage: number;
  quotaSyncedAt: string | null;
  lastError: string | null;
}

export interface AlertDto {
  id: string;
  kind: string;
  message: string;
  accountId: string | null;
  createdAt: string;
}

export interface ShareDto {
  id: string;
  nodeId: string;
  expiresAt: string | null;
  passwordProtected: boolean;
  downloadCount: number;
  revokedAt: string | null;
  createdAt: string;
  url?: string;
}
