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

export type PermissionSource = 'owner' | 'direct' | 'inherited';

export interface ShareInvite {
	id: string;
	resourcePath: string;
	resourceType: ResourceType;
	ownerId: string;
	ownerEmail: string;
	inviteeEmail: string;
	inviteeId: string | null;
	permission: Permission;
	createdAt: number;
	acceptedAt: number | null;
}

export interface CreateShareRequest {
	resourcePath: string;
	resourceType: ResourceType;
	inviteeEmail: string;
	permission: Permission;
}

export interface UpdateShareRequest {
	permission: Permission;
}

export interface ShareResponse {
	success: boolean;
	share?: ShareInvite;
	message?: string;
}

export interface ListSharesResponse {
	success: boolean;
	shares: ShareInvite[];
}

export interface EffectivePermission {
	permission: Permission;
	source: PermissionSource;
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
// WebSocket Protocol
// ============================================================================

export type ClientMessage =
	| { type: 'subscribe'; doc_id: string }
	| { type: 'unsubscribe'; doc_id: string }
	| { type: 'sync_step1'; doc_id: string; state_vector: string }
	| { type: 'sync_step2'; doc_id: string; update: string }
	| { type: 'update'; doc_id: string; update: string }
	| { type: 'awareness'; doc_id: string; data: string }
	| { type: 'ping'; timestamp: number };

export type ServerMessage =
	| { type: 'subscribed'; doc_id: string }
	| { type: 'unsubscribed'; doc_id: string }
	| { type: 'sync_step1'; doc_id: string; state_vector: string }
	| { type: 'sync_step2'; doc_id: string; update: string }
	| { type: 'update'; doc_id: string; update: string; from_user: string }
	| { type: 'awareness'; doc_id: string; data: string; from_user: string }
	| { type: 'error'; code: string; message: string }
	| { type: 'pong'; timestamp: number }
	| { type: 'user_joined'; doc_id: string; user_id: string; email: string }
	| { type: 'user_left'; doc_id: string; user_id: string };

// ============================================================================
// Comments
// ============================================================================

export interface Comment {
	id: string;
	authorId: string;
	authorEmail: string;
	content: string;
	position: string; // Base64 encoded yrs RelativePosition
	createdAt: number;
	updatedAt: number | null;
	resolved: boolean;
	parentId: string | null;
}

export interface CreateCommentRequest {
	content: string;
	position: string; // Base64 encoded yrs RelativePosition
	parentId?: string;
}

export interface UpdateCommentRequest {
	content?: string;
	resolved?: boolean;
}

export interface CommentResponse {
	success: boolean;
	comment?: Comment;
	message?: string;
}

export interface ListCommentsResponse {
	comments: Comment[];
}
