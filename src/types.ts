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
	device_id: string; // Device ID
}

export interface Device {
	id: string;
	userId: string;
	name: string;
	platform: string | null;
	lastSeenAt: number;
	createdAt: number;
}

export interface MagicLinkResponse {
	success: boolean;
	message: string;
}

export interface VerifyResponse {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	user: UserInfo;
	device: Device;
}

export interface RefreshResponse {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	user: UserInfo;
	device: Device;
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
	size: number;
	mtime: number; // File modification time in milliseconds
	contentType: string;
	contentHash: string;
	deleted: boolean;
	createdAt: number; // seconds
	updatedAt: number; // seconds
}

export interface FileListResponse {
	files: FileMeta[];
	cursor: string | null;
	hasMore: boolean;
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

export interface FileUploadResponse {
	success: boolean;
	path: string;
	size: number;
	contentHash: string;
	versionCreated: boolean;
	/** Whether a 3-way merge was performed */
	merged: boolean;
	/** Whether the merge had conflicts (conflict markers inserted) */
	hadConflict: boolean;
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

// ============================================================================
// WebSocket Messages
// ============================================================================

/** Message received from server via WebSocket */
export type ServerMessage =
	| { type: 'sync'; path: string; action: 'upload' | 'delete'; originDevice: string; contentHash?: string }
	| { type: 'connected'; deviceId: string }
	| { type: 'ping' }
	| { type: 'error'; message: string };

/** Message sent from client via WebSocket */
export type ClientMessage = { type: 'pong' };
