/**
 * ShareManager handles all sharing operations with the server.
 */

import { requestUrl } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type {
	CreateShareRequest,
	EffectivePermission,
	ListSharesResponse,
	Permission,
	ResourceType,
	ShareInvite,
	ShareResponse,
	UpdateShareRequest,
} from '../types';

export class ShareManager {
	private plugin: CloudflareSyncPlugin;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Get the base URL for API requests.
	 */
	private get baseUrl(): string {
		return this.plugin.settings.serverUrl;
	}

	/**
	 * Get authorization headers.
	 */
	private getHeaders(): Record<string, string> {
		return {
			...this.plugin.authManager.getAuthHeader(),
			'Content-Type': 'application/json',
		};
	}

	// ========================================================================
	// Share CRUD Operations
	// ========================================================================

	/**
	 * Create a new share for a file or folder.
	 */
	async createShare(
		resourcePath: string,
		resourceType: ResourceType,
		inviteeEmail: string,
		permission: Permission
	): Promise<ShareInvite | null> {
		const body: CreateShareRequest = {
			resourcePath,
			resourceType,
			inviteeEmail,
			permission,
		};

		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/share`,
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
			});

			const data = response.json as ShareResponse;
			if (data.success && data.share) {
				return data.share;
			}

			console.error('Failed to create share:', data.message);
			return null;
		} catch (error) {
			console.error('Error creating share:', error);
			return null;
		}
	}

	/**
	 * Get shares created by the current user.
	 */
	async getMyShares(): Promise<ShareInvite[]> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/shares`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			const data = response.json as ListSharesResponse;
			if (data.success) {
				return data.shares;
			}

			return [];
		} catch (error) {
			console.error('Error fetching my shares:', error);
			return [];
		}
	}

	/**
	 * Get shares shared with the current user.
	 */
	async getSharedWithMe(): Promise<ShareInvite[]> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/shared-with-me`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			const data = response.json as ListSharesResponse;
			if (data.success) {
				return data.shares;
			}

			return [];
		} catch (error) {
			console.error('Error fetching shared with me:', error);
			return [];
		}
	}

	/**
	 * Get a specific share by ID.
	 */
	async getShare(shareId: string): Promise<ShareInvite | null> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/share/${shareId}`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			const data = response.json as ShareResponse;
			if (data.success && data.share) {
				return data.share;
			}

			return null;
		} catch (error) {
			console.error('Error fetching share:', error);
			return null;
		}
	}

	/**
	 * Update a share's permission.
	 */
	async updateShare(shareId: string, permission: Permission): Promise<ShareInvite | null> {
		const body: UpdateShareRequest = { permission };

		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/share/${shareId}`,
				method: 'PUT',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
			});

			const data = response.json as ShareResponse;
			if (data.success && data.share) {
				return data.share;
			}

			console.error('Failed to update share:', data.message);
			return null;
		} catch (error) {
			console.error('Error updating share:', error);
			return null;
		}
	}

	/**
	 * Delete/revoke a share.
	 */
	async deleteShare(shareId: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/share/${shareId}`,
				method: 'DELETE',
				headers: this.getHeaders(),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error('Error deleting share:', error);
			return false;
		}
	}

	/**
	 * Accept a share invitation.
	 */
	async acceptShare(shareId: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/share/${shareId}/accept`,
				method: 'POST',
				headers: this.getHeaders(),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error('Error accepting share:', error);
			return false;
		}
	}

	// ========================================================================
	// Permission Checking
	// ========================================================================

	/**
	 * Check the user's effective permission for a resource.
	 */
	async checkPermission(resourcePath: string, ownerId: string): Promise<EffectivePermission | null> {
		try {
			const params = new URLSearchParams({
				path: resourcePath,
				owner_id: ownerId,
			});

			const response = await requestUrl({
				url: `${this.baseUrl}/permissions?${params.toString()}`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			return response.json as EffectivePermission;
		} catch (error) {
			// 403 Forbidden means no access
			console.error('Error checking permission:', error);
			return null;
		}
	}

	/**
	 * Check if user can edit a resource.
	 */
	async canEdit(resourcePath: string, ownerId: string): Promise<boolean> {
		const perm = await this.checkPermission(resourcePath, ownerId);
		if (!perm) return false;
		return perm.permission === 'owner' || perm.permission === 'editor';
	}

	/**
	 * Check if user can comment on a resource.
	 */
	async canComment(resourcePath: string, ownerId: string): Promise<boolean> {
		const perm = await this.checkPermission(resourcePath, ownerId);
		if (!perm) return false;
		return perm.permission === 'owner' || perm.permission === 'editor' || perm.permission === 'commenter';
	}

	/**
	 * Check if user can view a resource.
	 */
	async canView(resourcePath: string, ownerId: string): Promise<boolean> {
		const perm = await this.checkPermission(resourcePath, ownerId);
		return perm !== null; // Any permission means they can view
	}

	// ========================================================================
	// Helper Methods
	// ========================================================================

	/**
	 * Get shares for a specific resource path.
	 */
	async getSharesForResource(resourcePath: string): Promise<ShareInvite[]> {
		const allShares = await this.getMyShares();
		return allShares.filter((share) => share.resourcePath === resourcePath);
	}

	/**
	 * Get pending shares (not yet accepted).
	 */
	async getPendingShares(): Promise<ShareInvite[]> {
		const shares = await this.getSharedWithMe();
		return shares.filter((share) => share.acceptedAt === null);
	}

	/**
	 * Get human-readable permission label.
	 */
	getPermissionLabel(permission: Permission): string {
		switch (permission) {
			case 'owner':
				return 'Owner';
			case 'editor':
				return 'Can edit';
			case 'commenter':
				return 'Can comment';
			case 'viewer':
				return 'Can view';
		}
	}

	/**
	 * Get available permissions for sharing (excludes 'owner').
	 */
	getShareablePermissions(): Permission[] {
		return ['editor', 'commenter', 'viewer'];
	}
}
