/**
 * OfflineQueue - Stores and manages pending sync operations for offline support.
 * 
 * Operations are queued when the network is unavailable and automatically
 * processed when connectivity is restored.
 */

import type CloudflareSyncPlugin from '../main';

/**
 * Types of operations that can be queued
 */
export type OperationType = 'upload' | 'delete' | 'rename';

/**
 * A pending operation in the queue
 */
export interface PendingOperation {
	id: string;
	type: OperationType;
	path: string;
	/** For rename operations, the old path */
	oldPath?: string;
	/** Timestamp when the operation was queued */
	timestamp: number;
	/** Number of retry attempts */
	retries: number;
	/** Last error message if any */
	lastError?: string;
}

/**
 * Serializable queue data for persistence
 */
export interface OfflineQueueData {
	operations: PendingOperation[];
	lastOnline: number | null;
}

/**
 * Manages offline operation queuing and network status detection
 */
export class OfflineQueue {
	private plugin: CloudflareSyncPlugin;
	private operations: PendingOperation[] = [];
	private isOnline: boolean = true;
	private lastOnline: number | null = null;
	private onlineCheckInterval: ReturnType<typeof setInterval> | null = null;
	private statusChangeCallbacks: Array<(isOnline: boolean) => void> = [];

	/** Bound event handlers for cleanup */
	private boundHandleOnline: () => void;
	private boundHandleOffline: () => void;

	/** Interval for checking online status (30 seconds) */
	private static readonly ONLINE_CHECK_INTERVAL_MS = 30 * 1000;
	
	/** Maximum retry attempts before giving up on an operation */
	private static readonly MAX_RETRIES = 5;

	/** Key for storing queue data in plugin settings */
	private static readonly STORAGE_KEY = 'offlineQueue';

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
		this.boundHandleOnline = this.handleOnline.bind(this);
		this.boundHandleOffline = this.handleOffline.bind(this);
	}

	/**
	 * Initialize the offline queue
	 */
	async initialize(): Promise<void> {
		// Load persisted queue data
		await this.loadQueue();

		// Set initial online status
		this.isOnline = navigator.onLine;
		if (this.isOnline) {
			this.lastOnline = Date.now();
		}

		// Listen to browser online/offline events
		window.addEventListener('online', this.boundHandleOnline);
		window.addEventListener('offline', this.boundHandleOffline);

		// Start periodic online check (as a backup)
		this.startOnlineCheck();

		console.log(`[OfflineQueue] Initialized. Online: ${this.isOnline}, Pending: ${this.operations.length}`);
	}

	/**
	 * Cleanup resources
	 */
	cleanup(): void {
		window.removeEventListener('online', this.boundHandleOnline);
		window.removeEventListener('offline', this.boundHandleOffline);

		if (this.onlineCheckInterval) {
			clearInterval(this.onlineCheckInterval);
			this.onlineCheckInterval = null;
		}
	}

	// ========================================================================
	// Online Status
	// ========================================================================

	/**
	 * Check if we're currently online
	 */
	getIsOnline(): boolean {
		return this.isOnline;
	}

	/**
	 * Get the timestamp of when we were last online
	 */
	getLastOnlineTime(): number | null {
		return this.lastOnline;
	}

	/**
	 * Register a callback for online status changes
	 */
	onStatusChange(callback: (isOnline: boolean) => void): void {
		this.statusChangeCallbacks.push(callback);
	}

	/**
	 * Remove a status change callback
	 */
	offStatusChange(callback: (isOnline: boolean) => void): void {
		this.statusChangeCallbacks = this.statusChangeCallbacks.filter(cb => cb !== callback);
	}

	/**
	 * Manually check if the server is reachable
	 */
	async checkServerReachable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.plugin.settings.serverUrl}/health`, {
				method: 'GET',
				mode: 'cors',
				cache: 'no-cache',
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	private handleOnline(): void {
		if (!this.isOnline) {
			this.isOnline = true;
			this.lastOnline = Date.now();
			console.log('[OfflineQueue] Back online');
			this.notifyStatusChange(true);
		}
	}

	private handleOffline(): void {
		if (this.isOnline) {
			this.isOnline = false;
			console.log('[OfflineQueue] Gone offline');
			this.notifyStatusChange(false);
		}
	}

	private notifyStatusChange(isOnline: boolean): void {
		for (const callback of this.statusChangeCallbacks) {
			try {
				callback(isOnline);
			} catch (e) {
				console.error('[OfflineQueue] Status change callback error:', e);
			}
		}
	}

	private startOnlineCheck(): void {
		this.onlineCheckInterval = setInterval(async () => {
			const wasOnline = this.isOnline;
			const serverReachable = await this.checkServerReachable();
			
			if (serverReachable && !wasOnline) {
				this.handleOnline();
			} else if (!serverReachable && wasOnline) {
				this.handleOffline();
			}
		}, OfflineQueue.ONLINE_CHECK_INTERVAL_MS);
	}

	// ========================================================================
	// Queue Operations
	// ========================================================================

	/**
	 * Add an upload operation to the queue
	 */
	queueUpload(path: string): void {
		this.addOperation('upload', path);
	}

	/**
	 * Add a delete operation to the queue
	 */
	queueDelete(path: string): void {
		this.addOperation('delete', path);
	}

	/**
	 * Add a rename operation to the queue
	 */
	queueRename(oldPath: string, newPath: string): void {
		this.addOperation('rename', newPath, oldPath);
	}

	/**
	 * Add an operation to the queue
	 */
	private addOperation(type: OperationType, path: string, oldPath?: string): void {
		// Check for existing operation on same path
		const existing = this.operations.find(op => op.path === path);
		
		if (existing) {
			// Merge or update existing operation
			if (type === 'delete') {
				// Delete supersedes upload
				existing.type = 'delete';
				existing.timestamp = Date.now();
				existing.retries = 0;
				delete existing.lastError;
			} else if (type === 'upload' && existing.type === 'upload') {
				// Just update timestamp for duplicate uploads
				existing.timestamp = Date.now();
			}
			// For rename, keep the original operation
		} else {
			// Add new operation
			const operation: PendingOperation = {
				id: this.generateId(),
				type,
				path,
				oldPath,
				timestamp: Date.now(),
				retries: 0,
			};
			this.operations.push(operation);
		}

		// Persist the queue
		this.saveQueue();
		
		console.log(`[OfflineQueue] Queued ${type} for ${path}. Total: ${this.operations.length}`);
	}

	/**
	 * Remove an operation from the queue
	 */
	removeOperation(id: string): void {
		this.operations = this.operations.filter(op => op.id !== id);
		this.saveQueue();
	}

	/**
	 * Mark an operation as failed
	 */
	markFailed(id: string, error: string): void {
		const operation = this.operations.find(op => op.id === id);
		if (operation) {
			operation.retries++;
			operation.lastError = error;
			
			// Remove if max retries exceeded
			if (operation.retries >= OfflineQueue.MAX_RETRIES) {
				console.error(`[OfflineQueue] Max retries exceeded for ${operation.path}, removing from queue`);
				this.removeOperation(id);
			} else {
				this.saveQueue();
			}
		}
	}

	/**
	 * Get all pending operations
	 */
	getPendingOperations(): PendingOperation[] {
		return [...this.operations];
	}

	/**
	 * Get the number of pending operations
	 */
	getPendingCount(): number {
		return this.operations.length;
	}

	/**
	 * Check if there are pending operations
	 */
	hasPendingOperations(): boolean {
		return this.operations.length > 0;
	}

	/**
	 * Clear all pending operations
	 */
	clearQueue(): void {
		this.operations = [];
		this.saveQueue();
	}

	// ========================================================================
	// Persistence
	// ========================================================================

	/**
	 * Load queue from plugin data
	 */
	private async loadQueue(): Promise<void> {
		try {
			const data = await this.plugin.loadData();
			const queueData = data?.[OfflineQueue.STORAGE_KEY] as OfflineQueueData | undefined;
			
			if (queueData) {
				this.operations = queueData.operations || [];
				this.lastOnline = queueData.lastOnline;
			}
		} catch (e) {
			console.error('[OfflineQueue] Failed to load queue:', e);
			this.operations = [];
		}
	}

	/**
	 * Save queue to plugin data
	 */
	private async saveQueue(): Promise<void> {
		try {
			const data = (await this.plugin.loadData()) || {};
			data[OfflineQueue.STORAGE_KEY] = {
				operations: this.operations,
				lastOnline: this.lastOnline,
			} as OfflineQueueData;
			await this.plugin.saveData(data);
		} catch (e) {
			console.error('[OfflineQueue] Failed to save queue:', e);
		}
	}

	// ========================================================================
	// Utilities
	// ========================================================================

	/**
	 * Generate a unique operation ID
	 */
	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}

	/**
	 * Get a human-readable summary of the queue
	 */
	getQueueSummary(): string {
		if (this.operations.length === 0) {
			return 'No pending changes';
		}

		const uploads = this.operations.filter(op => op.type === 'upload').length;
		const deletes = this.operations.filter(op => op.type === 'delete').length;
		const renames = this.operations.filter(op => op.type === 'rename').length;

		const parts: string[] = [];
		if (uploads > 0) parts.push(`${uploads} upload${uploads !== 1 ? 's' : ''}`);
		if (deletes > 0) parts.push(`${deletes} delete${deletes !== 1 ? 's' : ''}`);
		if (renames > 0) parts.push(`${renames} rename${renames !== 1 ? 's' : ''}`);

		return `${this.operations.length} pending: ${parts.join(', ')}`;
	}
}
