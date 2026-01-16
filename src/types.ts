/**
 * Cloudflare Sync Plugin - Shared TypeScript Types
 */

// ============================================================================
// Connection & Sync Status
// ============================================================================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

// ============================================================================
// Authentication
// ============================================================================

export interface AuthState {
	isAuthenticated: boolean;
	userEmail: string | null;
	userId: string | null;
}

export interface JWTPayload {
	sub: string; // User ID
	email: string;
	exp: number; // Expiry timestamp (seconds)
	iat: number; // Issued at timestamp
}

export interface MagicLinkResponse {
	success: boolean;
	message: string;
}

export interface VerifyResponse {
	success: boolean;
	token: string;
	user: UserInfo;
}

export interface RefreshResponse {
	success: boolean;
	token: string;
}

export interface UserInfo {
	id: string;
	email: string;
	createdAt: number;
}

// ============================================================================
// API Responses
// ============================================================================

export interface ApiError {
	error: {
		code: string;
		message: string;
		status: number;
	};
}

export interface ApiSuccess<T> {
	success: boolean;
	data: T;
}

// ============================================================================
// File Operations
// ============================================================================

export interface FileMeta {
	path: string;
	pathHash: string;
	size: number;
	mimeType: string;
	createdAt: number;
	updatedAt: number;
	etag: string;
	deleted: boolean;
}

export interface FileListResponse {
	success: boolean;
	files: FileMeta[];
}

export interface FileVersion {
	timestamp: number;
	size: number;
	etag: string;
}

export interface FileVersionsResponse {
	success: boolean;
	path: string;
	versions: FileVersion[];
}

// ============================================================================
// Sharing & Permissions
// ============================================================================

export type Permission = 'owner' | 'editor' | 'commenter' | 'viewer';

export type ResourceType = 'file' | 'folder';

export interface ShareInvite {
	id: string;
	resourcePath: string;
	resourceType: ResourceType;
	ownerId: string;
	inviteeEmail: string;
	permission: Permission;
	createdAt: number;
	acceptedAt: number | null;
}

// ============================================================================
// Events
// ============================================================================

export interface SyncEvent {
	type: 'file-uploaded' | 'file-downloaded' | 'file-deleted' | 'sync-error';
	path: string;
	timestamp: number;
	error?: string;
}

export interface ConnectionEvent {
	type: 'connected' | 'disconnected' | 'reconnecting' | 'error';
	timestamp: number;
	error?: string;
}
