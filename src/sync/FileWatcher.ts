import { debounce, TAbstractFile, TFile, TFolder } from 'obsidian';
import type CloudflareSyncPlugin from '../main';

export type FileChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
	type: FileChangeType;
	file: TFile;
	oldPath?: string; // For rename events
	timestamp: number;
}

export type FileChangeCallback = (change: FileChange) => void;

/**
 * Watches vault for file changes and notifies listeners
 */
export class FileWatcher {
	private plugin: CloudflareSyncPlugin;
	private callbacks: Set<FileChangeCallback> = new Set();
	private pendingChanges: Map<string, FileChange> = new Map();
	private isWatching: boolean = false;

	/** Debounce time for batching rapid changes (ms) */
	private static readonly DEBOUNCE_MS = 500;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Start watching for file changes
	 */
	start(): void {
		if (this.isWatching) {
			return;
		}

		this.isWatching = true;

		// Register vault event listeners
		this.plugin.registerEvent(this.plugin.app.vault.on('create', this.handleCreate.bind(this)));

		this.plugin.registerEvent(this.plugin.app.vault.on('modify', this.handleModify.bind(this)));

		this.plugin.registerEvent(this.plugin.app.vault.on('delete', this.handleDelete.bind(this)));

		this.plugin.registerEvent(this.plugin.app.vault.on('rename', this.handleRename.bind(this)));
	}

	/**
	 * Stop watching for file changes
	 */
	stop(): void {
		this.isWatching = false;
		this.pendingChanges.clear();
		// Event listeners are automatically cleaned up by Obsidian's registerEvent
	}

	/**
	 * Register a callback to be notified of file changes
	 */
	onFileChange(callback: FileChangeCallback): void {
		this.callbacks.add(callback);
	}

	/**
	 * Unregister a callback
	 */
	offFileChange(callback: FileChangeCallback): void {
		this.callbacks.delete(callback);
	}

	/**
	 * Get all files in the vault that should be synced
	 */
	getAllSyncableFiles(): TFile[] {
		return this.plugin.app.vault.getFiles().filter((file) => this.shouldSync(file));
	}

	/**
	 * Check if a file should be synced
	 */
	shouldSync(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) {
			return false;
		}

		// Skip hidden files and folders (starting with .)
		const pathParts = file.path.split('/');
		for (const part of pathParts) {
			if (part.startsWith('.')) {
				return false;
			}
		}

		// Skip plugin data folder
		if (file.path.startsWith('.obsidian/')) {
			return false;
		}

		return true;
	}

	// ============================================================================
	// Event Handlers
	// ============================================================================

	private handleCreate(file: TAbstractFile): void {
		if (!this.shouldSync(file) || !(file instanceof TFile)) {
			return;
		}

		this.queueChange({
			type: 'create',
			file,
			timestamp: Date.now(),
		});
	}

	private handleModify(file: TAbstractFile): void {
		if (!this.shouldSync(file) || !(file instanceof TFile)) {
			return;
		}

		this.queueChange({
			type: 'modify',
			file,
			timestamp: Date.now(),
		});
	}

	private handleDelete(file: TAbstractFile): void {
		// For delete, we can't check shouldSync since file is already gone
		// Just check if it's a file path we would have synced
		if (file.path.startsWith('.obsidian/') || file.path.startsWith('.')) {
			return;
		}

		// We need to create a minimal file reference for the callback
		// Since the file is deleted, we create a pseudo-file object
		this.notifyCallbacks({
			type: 'delete',
			file: file as TFile,
			timestamp: Date.now(),
		});
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (!this.shouldSync(file) || !(file instanceof TFile)) {
			return;
		}

		this.queueChange({
			type: 'rename',
			file,
			oldPath,
			timestamp: Date.now(),
		});
	}

	// ============================================================================
	// Change Queue
	// ============================================================================

	private queueChange(change: FileChange): void {
		// Use file path as key to deduplicate rapid changes
		this.pendingChanges.set(change.file.path, change);
		this.flushChangesDebounced();
	}

	private flushChangesDebounced = debounce(
		() => {
			this.flushChanges();
		},
		FileWatcher.DEBOUNCE_MS,
		true,
	);

	private flushChanges(): void {
		const changes = Array.from(this.pendingChanges.values());
		this.pendingChanges.clear();

		for (const change of changes) {
			this.notifyCallbacks(change);
		}
	}

	private notifyCallbacks(change: FileChange): void {
		for (const callback of this.callbacks) {
			try {
				callback(change);
			} catch (error) {
				console.error('FileWatcher callback error:', error);
			}
		}
	}
}
