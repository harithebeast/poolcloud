export const ACCOUNT_STATUSES = ['HEALTHY', 'DEGRADED', 'DISCONNECTED', 'DRAINING'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const NODE_TYPES = ['file', 'folder'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];
