import { TFile } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { FileMeta, SyncProgress, SyncStatus } from '../types';
import { FileSync } from './FileSync';
import { FileChange, FileWatcher } from './FileWatcher';
import { OfflineQueue } from './OfflineQueue';
import { WebSocketClient } from './WebSocketClient';

interface SyncState {
	/** Map of file path to remote metadata */
	remoteFiles: Map<string, FileMeta>;
	/** Map of file path to local file hash */
	localHashes: Map<string, string>;
	/** Files pending upload */
	pendingUploads: Set<string>;
	/** Files pending download */
	pendingDownloads: Set<string>;
	/** Last sync timestamp */
	lastSync: number | null;
}

/** Default/idle sync progress state */
const DEFAULT_PROGRESS: SyncProgress = {
	isActive: false,
	phase: 'idle',
	totalFiles: 0,
	processedFiles: 0,
	currentFile: null,
	percentage: 0,
};

/**
 * Orchestrates all sync operations between local vault and remote storage
 */
export class SyncManager {
	private plugin: CloudflareSyncPlugin;
	private fileWatcher: FileWatcher;
	private fileSync: FileSync;
	private offlineQueue: OfflineQueue;
	private wsClient: WebSocketClient;
	private state: SyncState;
	private isSyncing: boolean = false;
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private isProcessingQueue: boolean = false;

	/** Current sync progress */
	private progress: SyncProgress = { ...DEFAULT_PROGRESS };
	/** Progress change callbacks */
	private progressCallbacks: Array<(progress: SyncProgress) => void> = [];

	/** Auto-sync interval (5 minutes) */
	private static readonly AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
		this.fileWatcher = new FileWatcher(plugin);
		this.fileSync = new FileSync(plugin);
		this.offlineQueue = new OfflineQueue(plugin);
		this.wsClient = new WebSocketClient(plugin);
		this.state = {
			remoteFiles: new Map(),
			localHashes: new Map(),
			pendingUploads: new Set(),
			pendingDownloads: new Set(),
			lastSync: null,
		};
	}

	/**
	 * Start the sync manager
	 */
	async start(): Promise<void> {
		console.log('[SyncManager] start() called');
		
		// Initialize offline queue
		console.log('[SyncManager] Initializing offline queue...');
		let t = Date.now();
		await this.offlineQueue.initialize();
		console.log(`[SyncManager] Offline queue initialized in ${Date.now() - t}ms`);
		
		// Listen for online status changes
		this.offlineQueue.onStatusChange(this.handleOnlineStatusChange.bind(this));

		// Start watching for file changes
		console.log('[SyncManager] Starting file watcher...');
		t = Date.now();
		this.fileWatcher.start();
		this.fileWatcher.onFileChange(this.handleFileChange.bind(this));
		console.log(`[SyncManager] File watcher started in ${Date.now() - t}ms`);

		// Set up WebSocket for real-time sync notifications
		this.wsClient.onSync(this.handleRemoteSyncNotification.bind(this));
		this.wsClient.onStatusChange((status) => {
			console.log(`[SyncManager] WebSocket status: ${status}`);
		});

		// Perform initial sync if online
		if (this.offlineQueue.getIsOnline()) {
			console.log('[SyncManager] Online - starting full sync in background...');
			// Don't await - let it run in background
			this.performFullSync().then(() => {
				console.log('[SyncManager] Background full sync completed');
				// Connect WebSocket after initial sync
				this.wsClient.connect();
			}).catch((err) => {
				console.error('[SyncManager] Background full sync failed:', err);
			});
		} else {
			console.log('[SyncManager] Offline - skipping initial sync');
			this.plugin.setSyncStatus('offline');
			this.plugin.notificationManager.warning('Offline - changes will sync when connected');
		}

		// Start auto-sync interval
		this.syncInterval = setInterval(() => {
			if (this.plugin.settings.syncEnabled && !this.isSyncing && this.offlineQueue.getIsOnline()) {
				this.performFullSync();
			}
		}, SyncManager.AUTO_SYNC_INTERVAL_MS);
		
		console.log('[SyncManager] start() returning (sync runs in background)');
	}

	/**
	 * Stop the sync manager
	 */
	async stop(): Promise<void> {
		// Stop auto-sync
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}

		// Disconnect WebSocket
		this.wsClient.disconnect();

		// Stop file watcher
		this.fileWatcher.stop();

		// Cleanup offline queue
		this.offlineQueue.cleanup();

		// Flush pending changes if online
		if (this.offlineQueue.getIsOnline()) {
			await this.flushPendingChanges();
		}
	}

	/**
	 * Handle online status changes
	 */
	private async handleOnlineStatusChange(isOnline: boolean): Promise<void> {
		if (isOnline) {
			this.plugin.notificationManager.success('Back online - syncing changes');
			this.plugin.setSyncStatus('syncing');

			// Reconnect WebSocket
			this.wsClient.connect();

			// Process any queued operations first
			await this.processOfflineQueue();

			// Then do a full sync
			await this.performFullSync();
		} else {
			this.plugin.setSyncStatus('offline');
			this.plugin.notificationManager.warning('Offline - changes will be queued');
			// Disconnect WebSocket when offline
			this.wsClient.disconnect();
		}
	}

	/**
	 * Handle real-time sync notification from WebSocket.
	 * Called when another device uploads or deletes a file.
	 */
	private async handleRemoteSyncNotification(
		path: string,
		action: 'upload' | 'delete',
		originDevice: string,
		_contentHash?: string
	): Promise<void> {
		// Ignore notifications from our own device
		const myDeviceId = this.plugin.settings.deviceId;
		if (originDevice === myDeviceId) {
			return;
		}

		console.log(`[SyncManager] Remote sync notification: ${action} ${path} from device ${originDevice}`);

		if (action === 'upload') {
			// Another device uploaded a file - download it
			await this.downloadFile(path);
		} else if (action === 'delete') {
			// Another device deleted a file - delete locally
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				console.log(`[SyncManager] Deleting local file ${path} (deleted on another device)`);
				await this.plugin.app.vault.delete(file);
				// Remove base hash
				delete this.plugin.settings.fileBaseHashes[path];
				await this.plugin.saveSettings();
			}
		}
	}

	/**
	 * Process queued offline operations
	 */
	private async processOfflineQueue(): Promise<void> {
		if (this.isProcessingQueue) {
			return;
		}

		const operations = this.offlineQueue.getPendingOperations();
		if (operations.length === 0) {
			return;
		}

		this.isProcessingQueue = true;
		console.log(`[SyncManager] Processing ${operations.length} queued operations`);

		for (const op of operations) {
			try {
				switch (op.type) {
					case 'upload': {
						const file = this.plugin.app.vault.getAbstractFileByPath(op.path);
						if (file instanceof TFile) {
							const result = await this.fileSync.uploadFile(file);
							if (result.success) {
								this.offlineQueue.removeOperation(op.id);
							} else {
								this.offlineQueue.markFailed(op.id, result.error ?? 'Upload failed');
							}
						} else {
							// File no longer exists, remove from queue
							this.offlineQueue.removeOperation(op.id);
						}
						break;
					}
					case 'delete': {
						const result = await this.fileSync.deleteFile(op.path);
						if (result) {
							this.offlineQueue.removeOperation(op.id);
						} else {
							this.offlineQueue.markFailed(op.id, 'Delete failed');
						}
						break;
					}
					case 'rename': {
						// Delete old path first
						if (op.oldPath) {
							await this.fileSync.deleteFile(op.oldPath);
						}
						// Upload new path
						const file = this.plugin.app.vault.getAbstractFileByPath(op.path);
						if (file instanceof TFile) {
							const result = await this.fileSync.uploadFile(file);
							if (result.success) {
								this.offlineQueue.removeOperation(op.id);
							} else {
								this.offlineQueue.markFailed(op.id, result.error ?? 'Rename upload failed');
							}
						} else {
							// File no longer exists, remove from queue
							this.offlineQueue.removeOperation(op.id);
						}
						break;
					}
				}
			} catch (e) {
				const errorMsg = e instanceof Error ? e.message : 'Unknown error';
				console.error(`[SyncManager] Failed to process queued operation ${op.id}:`, e);
				this.offlineQueue.markFailed(op.id, errorMsg);
			}
		}

		this.isProcessingQueue = false;

		const remaining = this.offlineQueue.getPendingCount();
		if (remaining > 0) {
			console.log(`[SyncManager] ${remaining} operations still pending after processing`);
		} else {
			console.log('[SyncManager] All queued operations processed');
		}
	}

	/**
	 * Perform a full sync between local and remote
	 */
	async performFullSync(): Promise<void> {
		if (this.isSyncing) {
			console.log('[SyncManager] performFullSync() skipped - already syncing');
			return;
		}

		console.log('[SyncManager] performFullSync() starting...');
		const syncStart = Date.now();
		this.isSyncing = true;
		this.plugin.setSyncStatus('syncing');
		this.updateProgress({ isActive: true, phase: 'listing', totalFiles: 0, processedFiles: 0, currentFile: null });

		try {
			// 1. Get remote file list
			console.log('[SyncManager] Fetching remote file list...');
			let t = Date.now();
			const remoteFiles = await this.fileSync.listFiles();
			console.log(`[SyncManager] Got ${remoteFiles.length} remote files in ${Date.now() - t}ms`);
			
			this.state.remoteFiles.clear();
			for (const file of remoteFiles) {
				this.state.remoteFiles.set(file.path, file);
			}

			// 2. Get local files
			console.log('[SyncManager] Getting local files...');
			t = Date.now();
			const localFiles = this.fileWatcher.getAllSyncableFiles();
			console.log(`[SyncManager] Got ${localFiles.length} local files in ${Date.now() - t}ms`);

			// 3. Calculate differences
			console.log('[SyncManager] Calculating diff...');
			t = Date.now();
			const { toUpload, toDownload, toDelete } = await this.calculateDiff(localFiles, remoteFiles);
			console.log(`[SyncManager] Diff calculated in ${Date.now() - t}ms: ${toUpload.length} to upload, ${toDownload.length} to download, ${toDelete.length} to delete`);

			const totalOperations = toUpload.length + toDownload.length;
			let processedCount = 0;

			// 4. Process uploads in parallel
			if (toUpload.length > 0) {
				console.log(`[SyncManager] Uploading ${toUpload.length} files in parallel...`);
				this.updateProgress({ phase: 'uploading', totalFiles: totalOperations, processedFiles: processedCount });
				t = Date.now();
				
				await Promise.all(
					toUpload.map(async (file) => {
						await this.uploadFile(file);
						processedCount++;
						this.updateProgress({ processedFiles: processedCount, currentFile: file.path });
					})
				);
				console.log(`[SyncManager] Uploads completed in ${Date.now() - t}ms`);
			}

			// 5. Process downloads in parallel
			if (toDownload.length > 0) {
				console.log(`[SyncManager] Downloading ${toDownload.length} files in parallel...`);
				this.updateProgress({ phase: 'downloading', totalFiles: totalOperations, processedFiles: processedCount });
				t = Date.now();
				
				await Promise.all(
					toDownload.map(async (path) => {
						await this.downloadFile(path);
						processedCount++;
						this.updateProgress({ processedFiles: processedCount, currentFile: path });
					})
				);
				console.log(`[SyncManager] Downloads completed in ${Date.now() - t}ms`);
			}

			// 6. Process deletes (remote files that should be deleted)
			for (const path of toDelete) {
				// For now, we don't auto-delete - just log
				console.log(`[SyncManager] Remote file ${path} was deleted locally`);
			}

			this.state.lastSync = Date.now();
			this.plugin.setSyncStatus('idle');
			this.updateProgress({ isActive: false, phase: 'complete', currentFile: null, processedFiles: totalOperations, percentage: 100 });
			console.log(`[SyncManager] performFullSync() completed in ${Date.now() - syncStart}ms`);
		} catch (error) {
			console.error('[SyncManager] Full sync failed:', error);
			this.plugin.setSyncStatus('error');
			this.plugin.notificationManager.error('Sync failed');
			this.resetProgress();
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Force re-upload all local files to remote.
	 * Clears remote metadata first, then uploads all local files.
	 */
	async forceReuploadAll(): Promise<void> {
		if (this.isSyncing) {
			this.plugin.notificationManager.warning('Sync already in progress');
			return;
		}

		console.log('[SyncManager] forceReuploadAll() starting...');
		const startTime = Date.now();
		this.isSyncing = true;
		this.plugin.setSyncStatus('syncing');
		this.updateProgress({ isActive: true, phase: 'listing', totalFiles: 0, processedFiles: 0, currentFile: null });

		try {
			// 1. Clear remote file metadata
			console.log('[SyncManager] Clearing remote file metadata...');
			const cleared = await this.fileSync.clearRemoteFiles();
			if (!cleared) {
				throw new Error('Failed to clear remote file metadata');
			}
			console.log('[SyncManager] Remote metadata cleared');

			// 2. Clear local base hashes since we're starting fresh
			this.plugin.settings.fileBaseHashes = {};
			await this.plugin.saveSettings();

			// 3. Get all local files
			const localFiles = this.fileWatcher.getAllSyncableFiles();
			console.log(`[SyncManager] Uploading ${localFiles.length} local files...`);
			this.updateProgress({ phase: 'uploading', totalFiles: localFiles.length, processedFiles: 0 });

		// 4. Upload all local files in parallel
		let uploaded = 0;
		let failed = 0;
		
		await Promise.all(
			localFiles.map(async (file) => {
				const result = await this.fileSync.uploadFile(file);
				if (result.success) {
					uploaded++;
					// Track base hash for future conflict detection
					if (result.contentHash) {
						this.plugin.settings.fileBaseHashes[file.path] = result.contentHash;
					}
				} else {
					failed++;
					console.error(`[SyncManager] Failed to upload ${file.path}: ${result.error}`);
				}
				this.updateProgress({ processedFiles: uploaded + failed, currentFile: file.path });
			})
		);

			// Save base hashes
			await this.plugin.saveSettings();

			// 4. Update state
			this.state.remoteFiles.clear();
			this.state.lastSync = Date.now();
			this.plugin.setSyncStatus('idle');
			this.updateProgress({ isActive: false, phase: 'complete', currentFile: null, processedFiles: localFiles.length, percentage: 100 });

			const duration = Date.now() - startTime;
			console.log(`[SyncManager] forceReuploadAll() completed in ${duration}ms: ${uploaded} uploaded, ${failed} failed`);
			this.plugin.notificationManager.success(`Re-uploaded ${uploaded} files${failed > 0 ? ` (${failed} failed)` : ''}`);
		} catch (error) {
			console.error('[SyncManager] Force re-upload failed:', error);
			this.plugin.setSyncStatus('error');
			this.plugin.notificationManager.error('Force re-upload failed');
			this.resetProgress();
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Calculate differences between local and remote files
	 */
	private async calculateDiff(
		localFiles: TFile[],
		remoteFiles: FileMeta[],
	): Promise<{
		toUpload: TFile[];
		toDownload: string[];
		toDelete: string[];
	}> {
		const toUpload: TFile[] = [];
		const toDownload: string[] = [];
		const toDelete: string[] = [];

		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
		const localPaths = new Set(localFiles.map((f) => f.path));

		// Check local files against remote
		for (const localFile of localFiles) {
			const remoteMeta = remoteMap.get(localFile.path);

			if (!remoteMeta) {
				// File exists locally but not remotely - upload
				toUpload.push(localFile);
			} else if (!remoteMeta.deleted) {
				// File exists in both - check if local is newer
				// Use mtime (milliseconds) for comparison
				const localMtime = localFile.stat.mtime;
				const remoteMtime = remoteMeta.mtime;

				if (localMtime > remoteMtime) {
					// Local is newer - upload
					toUpload.push(localFile);
				} else if (remoteMtime > localMtime) {
					// Remote is newer - download
					toDownload.push(localFile.path);
				}
				// If same mtime, assume they're in sync
			}
		}

		// Check for remote files not in local
		for (const remoteMeta of remoteFiles) {
			if (!remoteMeta.deleted && !localPaths.has(remoteMeta.path)) {
				// File exists remotely but not locally - download
				toDownload.push(remoteMeta.path);
			}
		}

		// Check for deleted files (files that exist remotely but were deleted locally)
		// This is handled by tracking deletions through the file watcher

		return { toUpload, toDownload, toDelete };
	}

	/**
	 * Handle a file change event
	 */
	private async handleFileChange(change: FileChange): Promise<void> {
		if (!this.plugin.settings.syncEnabled) {
			return;
		}

		// If offline, queue the operation instead of executing immediately
		if (!this.offlineQueue.getIsOnline()) {
			switch (change.type) {
				case 'create':
				case 'modify':
					this.offlineQueue.queueUpload(change.file.path);
					break;
				case 'delete':
					this.offlineQueue.queueDelete(change.file.path);
					break;
				case 'rename':
					if (change.oldPath) {
						this.offlineQueue.queueRename(change.oldPath, change.file.path);
					} else {
						this.offlineQueue.queueUpload(change.file.path);
					}
					break;
			}
			return;
		}

		// Online - process normally
		switch (change.type) {
			case 'create':
			case 'modify':
				// Queue for upload
				this.state.pendingUploads.add(change.file.path);
				this.debouncedProcessPending();
				break;

			case 'delete':
				// Delete from remote
				await this.fileSync.deleteFile(change.file.path);
				break;

			case 'rename':
				// Delete old path, upload new path
				if (change.oldPath) {
					await this.fileSync.deleteFile(change.oldPath);
				}
				this.state.pendingUploads.add(change.file.path);
				this.debouncedProcessPending();
				break;
		}
	}

	/**
	 * Debounced processing of pending changes
	 */
	private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
	private debouncedProcessPending(): void {
		if (this.pendingTimeout) {
			clearTimeout(this.pendingTimeout);
		}
		this.pendingTimeout = setTimeout(() => {
			this.processPendingChanges();
		}, 1000);
	}

	/**
	 * Process pending file changes
	 */
	private async processPendingChanges(): Promise<void> {
		if (this.isSyncing || this.state.pendingUploads.size === 0) {
			return;
		}

		this.plugin.setSyncStatus('syncing');

		const paths = Array.from(this.state.pendingUploads);
		this.state.pendingUploads.clear();

		for (const path of paths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.uploadFile(file);
			}
		}

		this.plugin.setSyncStatus('idle');
	}

	/**
	 * Upload a single file
	 */
	private async uploadFile(file: TFile): Promise<boolean> {
		const result = await this.fileSync.uploadFile(file);

		if (result.success) {
			// Update base hash for future conflict detection
			if (result.contentHash) {
				this.plugin.settings.fileBaseHashes[file.path] = result.contentHash;
				// Don't await - save in background to not slow down sync
				this.plugin.saveSettings();
			}

			// Update local hash cache
			const hash = await this.fileSync.getLocalFileHash(file);
			this.state.localHashes.set(file.path, hash);

			// Handle merge results
			if (result.merged) {
				if (result.hadConflict) {
					// Server merged with conflicts - need to re-download to get merged content
					this.plugin.notificationManager.warning(
						`Conflict in ${file.path} - please review conflict markers`
					);
					// Re-download to get the merged content with conflict markers
					await this.downloadAndUpdateFile(file.path);
				} else {
					// Clean merge - re-download to get the merged content
					this.plugin.notificationManager.info(`Merged changes in ${file.path}`);
					await this.downloadAndUpdateFile(file.path);
				}
			}
		} else {
			console.error(`Upload failed for ${file.path}:`, result.error);
		}

		return result.success;
	}

	/**
	 * Download a file and update base hash
	 */
	private async downloadAndUpdateFile(path: string): Promise<boolean> {
		const result = await this.fileSync.downloadFile(path);

		if (result.success && result.content) {
			const written = await this.fileSync.writeToVault(path, result.content);
			
			if (written && result.contentHash) {
				// Update base hash to match downloaded content
				this.plugin.settings.fileBaseHashes[path] = result.contentHash;
				await this.plugin.saveSettings();
			}

			return written;
		}

		return false;
	}

	/**
	 * Download a single file
	 */
	private async downloadFile(path: string): Promise<boolean> {
		const result = await this.fileSync.downloadFile(path);

		if (result.success && result.content) {
			const written = await this.fileSync.writeToVault(path, result.content);
			
			if (written && result.contentHash) {
				// Update base hash to match downloaded content
				this.plugin.settings.fileBaseHashes[path] = result.contentHash;
				// Don't await - save in background
				this.plugin.saveSettings();
			}

			return written;
		}

		return false;
	}

	/**
	 * Flush all pending changes before stopping
	 */
	private async flushPendingChanges(): Promise<void> {
		if (this.pendingTimeout) {
			clearTimeout(this.pendingTimeout);
			this.pendingTimeout = null;
		}

		await this.processPendingChanges();
	}

	/**
	 * Get current sync status for display
	 */
	getSyncStatus(): SyncStatus {
		if (this.isSyncing) {
			return 'syncing';
		}
		if (this.state.pendingUploads.size > 0 || this.state.pendingDownloads.size > 0) {
			return 'syncing';
		}
		return 'idle';
	}

	/**
	 * Get the file watcher instance
	 */
	getFileWatcher(): FileWatcher {
		return this.fileWatcher;
	}

	/**
	 * Get the file sync instance
	 */
	getFileSync(): FileSync {
		return this.fileSync;
	}

	/**
	 * Get the offline queue instance
	 */
	getOfflineQueue(): OfflineQueue {
		return this.offlineQueue;
	}

	// ============================================================================
	// Progress Tracking
	// ============================================================================

	/**
	 * Get the current sync progress
	 */
	getProgress(): SyncProgress {
		return { ...this.progress };
	}

	/**
	 * Subscribe to progress updates
	 * Returns unsubscribe function
	 */
	onProgress(callback: (progress: SyncProgress) => void): () => void {
		this.progressCallbacks.push(callback);
		// Immediately call with current progress
		callback({ ...this.progress });
		return () => {
			const index = this.progressCallbacks.indexOf(callback);
			if (index !== -1) {
				this.progressCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Update progress and notify listeners
	 */
	private updateProgress(update: Partial<SyncProgress>): void {
		this.progress = { ...this.progress, ...update };
		
		// Calculate percentage
		if (this.progress.totalFiles > 0) {
			this.progress.percentage = Math.round(
				(this.progress.processedFiles / this.progress.totalFiles) * 100
			);
		} else {
			this.progress.percentage = 0;
		}

		// Notify listeners
		for (const callback of this.progressCallbacks) {
			callback({ ...this.progress });
		}
	}

	/**
	 * Reset progress to idle state
	 */
	private resetProgress(): void {
		this.updateProgress({ ...DEFAULT_PROGRESS });
	}
}
