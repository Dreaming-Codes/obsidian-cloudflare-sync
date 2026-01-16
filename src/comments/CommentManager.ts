/**
 * CommentManager handles all comment operations with the server.
 * Comments are stored per-document in DocumentDO.
 */

import { requestUrl } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type {
	Comment,
	CreateCommentRequest,
	UpdateCommentRequest,
} from '../types';

export class CommentManager {
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

	/**
	 * Generate a document ID from a file path.
	 * Uses SHA-256 hash of the path for consistent document IDs.
	 */
	async getDocId(filePath: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(filePath);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// ========================================================================
	// Comment CRUD Operations
	// ========================================================================

	/**
	 * List all comments for a document.
	 */
	async listComments(docId: string): Promise<Comment[]> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/docs/${docId}/comments`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			// The API returns the array directly, not wrapped in an object
			const data = response.json as Comment[];
			return data;
		} catch (error) {
			console.error('Error fetching comments:', error);
			return [];
		}
	}

	/**
	 * Create a new comment on a document.
	 */
	async createComment(
		docId: string,
		content: string,
		position: string,
		parentId?: string
	): Promise<Comment | null> {
		const body: CreateCommentRequest = {
			content,
			position,
			parentId,
		};

		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/docs/${docId}/comments`,
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
			});

			const data = response.json as Comment;
			return data;
		} catch (error) {
			console.error('Error creating comment:', error);
			return null;
		}
	}

	/**
	 * Update a comment (content or resolved status).
	 */
	async updateComment(
		docId: string,
		commentId: string,
		updates: UpdateCommentRequest
	): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/docs/${docId}/comments/${commentId}`,
				method: 'PUT',
				headers: this.getHeaders(),
				body: JSON.stringify(updates),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error('Error updating comment:', error);
			return false;
		}
	}

	/**
	 * Delete a comment (and its replies).
	 */
	async deleteComment(docId: string, commentId: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/docs/${docId}/comments/${commentId}`,
				method: 'DELETE',
				headers: this.getHeaders(),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error('Error deleting comment:', error);
			return false;
		}
	}

	/**
	 * Resolve a comment.
	 */
	async resolveComment(docId: string, commentId: string): Promise<boolean> {
		return this.updateComment(docId, commentId, { resolved: true });
	}

	/**
	 * Unresolve a comment.
	 */
	async unresolveComment(docId: string, commentId: string): Promise<boolean> {
		return this.updateComment(docId, commentId, { resolved: false });
	}

	// ========================================================================
	// Helper Methods
	// ========================================================================

	/**
	 * Get comments for a specific file path.
	 */
	async getCommentsForFile(filePath: string): Promise<Comment[]> {
		const docId = await this.getDocId(filePath);
		return this.listComments(docId);
	}

	/**
	 * Create a comment on a file.
	 */
	async commentOnFile(
		filePath: string,
		content: string,
		position: string,
		parentId?: string
	): Promise<Comment | null> {
		const docId = await this.getDocId(filePath);
		return this.createComment(docId, content, position, parentId);
	}

	/**
	 * Get top-level comments (non-replies).
	 */
	filterTopLevelComments(comments: Comment[]): Comment[] {
		return comments.filter(c => c.parentId === null);
	}

	/**
	 * Get replies to a specific comment.
	 */
	getReplies(comments: Comment[], parentId: string): Comment[] {
		return comments.filter(c => c.parentId === parentId);
	}

	/**
	 * Get unresolved comments.
	 */
	filterUnresolved(comments: Comment[]): Comment[] {
		return comments.filter(c => !c.resolved);
	}

	/**
	 * Get resolved comments.
	 */
	filterResolved(comments: Comment[]): Comment[] {
		return comments.filter(c => c.resolved);
	}

	/**
	 * Build a threaded comment structure.
	 */
	buildThreadedComments(comments: Comment[]): Map<string | null, Comment[]> {
		const threads = new Map<string | null, Comment[]>();
		
		// Initialize with null key for top-level comments
		threads.set(null, []);

		for (const comment of comments) {
			const key = comment.parentId;
			if (!threads.has(key)) {
				threads.set(key, []);
			}
			threads.get(key)!.push(comment);
		}

		// Sort each thread by creation time
		for (const [, threadComments] of threads) {
			threadComments.sort((a, b) => a.createdAt - b.createdAt);
		}

		return threads;
	}

	/**
	 * Format a timestamp for display.
	 */
	formatTimestamp(timestamp: number): string {
		const date = new Date(timestamp * 1000);
		const now = new Date();
		const diff = now.getTime() - date.getTime();

		// Less than a minute
		if (diff < 60000) {
			return 'Just now';
		}

		// Less than an hour
		if (diff < 3600000) {
			const mins = Math.floor(diff / 60000);
			return `${mins}m ago`;
		}

		// Less than a day
		if (diff < 86400000) {
			const hours = Math.floor(diff / 3600000);
			return `${hours}h ago`;
		}

		// Less than a week
		if (diff < 604800000) {
			const days = Math.floor(diff / 86400000);
			return `${days}d ago`;
		}

		// Show date
		return date.toLocaleDateString();
	}
}
