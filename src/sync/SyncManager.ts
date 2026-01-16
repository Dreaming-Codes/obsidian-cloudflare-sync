import { TFile } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { FileMeta, SyncStatus } from '../types';
import { FileSync } from './FileSync';
import { FileChange, FileWatcher } from './FileWatcher';

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

/**
 * Orchestrates all sync operations between local vault and remote storage
 */
export class SyncManager {
	private plugin: CloudflareSyncPlugin;
	private fileWatcher: FileWatcher;
	private fileSync: FileSync;
	private state: SyncState;
	private isSyncing: boolean = false;
	private syncInterval: ReturnType<typeof setInterval> | null = null;

	/** Auto-sync interval (5 minutes) */
	private static readonly AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
		this.fileWatcher = new FileWatcher(plugin);
		this.fileSync = new FileSync(plugin);
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
		// Start watching for file changes
		this.fileWatcher.start();
		this.fileWatcher.onFileChange(this.handleFileChange.bind(this));

		// Perform initial sync
		await this.performFullSync();

		// Start auto-sync interval
		this.syncInterval = setInterval(() => {
			if (this.plugin.settings.syncEnabled && !this.isSyncing) {
				this.performFullSync();
			}
		}, SyncManager.AUTO_SYNC_INTERVAL_MS);
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

		// Stop file watcher
		this.fileWatcher.stop();

		// Flush pending changes
		await this.flushPendingChanges();
	}

	/**
	 * Perform a full sync between local and remote
	 */
	async performFullSync(): Promise<void> {
		if (this.isSyncing) {
			return;
		}

		this.isSyncing = true;
		this.plugin.setSyncStatus('syncing');

		try {
			// 1. Get remote file list
			const remoteFiles = await this.fileSync.listFiles();
			this.state.remoteFiles.clear();
			for (const file of remoteFiles) {
				this.state.remoteFiles.set(file.path, file);
			}

			// 2. Get local files
			const localFiles = this.fileWatcher.getAllSyncableFiles();

			// 3. Calculate differences
			const { toUpload, toDownload, toDelete } = await this.calculateDiff(localFiles, remoteFiles);

			// 4. Process uploads
			for (const file of toUpload) {
				await this.uploadFile(file);
			}

			// 5. Process downloads
			for (const path of toDownload) {
				await this.downloadFile(path);
			}

			// 6. Process deletes (remote files that should be deleted)
			for (const path of toDelete) {
				// For now, we don't auto-delete - just log
				console.log(`Remote file ${path} was deleted locally`);
			}

			this.state.lastSync = Date.now();
			this.plugin.setSyncStatus('idle');
		} catch (error) {
			console.error('Full sync failed:', error);
			this.plugin.setSyncStatus('error');
			this.plugin.notificationManager.error('Sync failed');
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
				const localMtime = localFile.stat.mtime;
				const remoteMtime = remoteMeta.updatedAt;

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
			// Update local hash cache
			const hash = await this.fileSync.getLocalFileHash(file);
			this.state.localHashes.set(file.path, hash);
		} else {
			console.error(`Upload failed for ${file.path}:`, result.error);
		}

		return result.success;
	}

	/**
	 * Download a single file
	 */
	private async downloadFile(path: string): Promise<boolean> {
		const result = await this.fileSync.downloadFile(path);

		if (result.success && result.content) {
			return await this.fileSync.writeToVault(path, result.content);
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
}
