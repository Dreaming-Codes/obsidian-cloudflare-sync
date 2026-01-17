/**
 * SharedFileCacheManager - Manages temporary cache files for shared documents.
 * 
 * Creates local temporary files in .obsidian/plugins/cloudflare-sync/.shared-cache/
 * that can be opened with Obsidian's native MarkdownView. This allows shared files
 * to use all of Obsidian's editor features while syncing via CRDT.
 */

import { App, TFile, TFolder } from 'obsidian';

export interface CachedSharedFile {
	/** The cache file path in the vault */
	cachePath: string;
	/** The TFile object for the cached file */
	file: TFile;
	/** Owner's user ID */
	ownerId: string;
	/** Original resource path on the owner's vault */
	resourcePath: string;
	/** Generated document ID for CRDT sync */
	docId: string;
}

/**
 * Generates a document ID from an owner ID and file path.
 * Format: {owner_id}:{path_hash}
 */
export async function generateDocId(ownerId: string, path: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(path);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const pathHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return `${ownerId}:${pathHash}`;
}

/**
 * Generates a short hash for cache file naming.
 */
async function generateShortHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	// Use first 16 characters of the hex hash
	return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class SharedFileCacheManager {
	private app: App;
	private cacheDir: string;
	private cachedFiles: Map<string, CachedSharedFile> = new Map();

	constructor(app: App) {
		this.app = app;
		// Store cached files in a folder in the vault root
		// Note: Obsidian doesn't index dot-prefixed folders, so we use a regular name
		this.cacheDir = 'Cloudflare Sync Cache';
	}

	/**
	 * Initialize the cache manager - creates the cache directory if needed.
	 */
	async initialize(): Promise<void> {
		await this.ensureCacheDir();
	}

	/**
	 * Ensure the cache directory exists and is indexed by the vault.
	 */
	private async ensureCacheDir(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folderExists = await adapter.exists(this.cacheDir);
		const folderIndexed = this.app.vault.getAbstractFileByPath(this.cacheDir);

		if (folderIndexed) {
			// Folder exists and is indexed - we're good
			return;
		}

		if (folderExists) {
			// Folder exists on disk but not indexed
			// Wait for Obsidian to index it, or trigger a refresh
			console.log(`[SharedFileCacheManager] Cache folder exists on disk, waiting for indexing...`);
			for (let i = 0; i < 20; i++) {
				await new Promise(resolve => setTimeout(resolve, 100));
				if (this.app.vault.getAbstractFileByPath(this.cacheDir)) {
					console.log(`[SharedFileCacheManager] Cache folder indexed after ${(i + 1) * 100}ms`);
					return;
				}
			}
			// Still not indexed after 2 seconds - this shouldn't happen normally
			console.warn(`[SharedFileCacheManager] Cache folder not indexed after 2s, continuing anyway`);
			return;
		}

		// Folder doesn't exist - create it
		console.log(`[SharedFileCacheManager] Creating cache directory: ${this.cacheDir}`);
		try {
			await this.app.vault.createFolder(this.cacheDir);
		} catch (error) {
			// Might fail if folder was created between our check and create
			if (String(error).includes('already exists')) {
				console.log(`[SharedFileCacheManager] Folder was created concurrently, continuing`);
			} else {
				throw error;
			}
		}
		
		// Wait for the folder to be indexed
		console.log(`[SharedFileCacheManager] Waiting for folder to be indexed...`);
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			if (this.app.vault.getAbstractFileByPath(this.cacheDir)) {
				console.log(`[SharedFileCacheManager] Cache folder indexed after ${(i + 1) * 100}ms`);
				return;
			}
		}
		console.warn(`[SharedFileCacheManager] Cache folder created but not indexed after 2s`);
	}

	/**
	 * Get or create a cached file for a shared document.
	 * Returns the TFile that can be opened in MarkdownView.
	 */
	async getOrCreateCacheFile(
		ownerId: string,
		resourcePath: string,
		initialContent: string = ''
	): Promise<CachedSharedFile> {
		const docId = await generateDocId(ownerId, resourcePath);

		// Check if already cached in memory
		const existing = this.cachedFiles.get(docId);
		if (existing) {
			// Verify the file still exists
			const file = this.app.vault.getAbstractFileByPath(existing.cachePath);
			if (file instanceof TFile) {
				// Update content if provided
				if (initialContent) {
					await this.app.vault.modify(file, initialContent);
				}
				return existing;
			}
			// File was deleted, remove from cache
			this.cachedFiles.delete(docId);
		}

		// Ensure cache directory exists
		await this.ensureCacheDir();

		// Create a unique cache file name
		// Format: {short_hash}_{sanitized_filename}.md
		const shortHash = await generateShortHash(docId);
		const fileName = this.sanitizeFileName(resourcePath);
		const cachePath = `${this.cacheDir}/${shortHash}_${fileName}`;

		console.log(`[SharedFileCacheManager] Creating/getting cache file: ${cachePath}`);

		// Check if file already exists in vault
		let file = this.app.vault.getAbstractFileByPath(cachePath) as TFile | null;
		
		if (file instanceof TFile) {
			console.log(`[SharedFileCacheManager] File already exists in vault, updating content`);
			// File exists and is indexed, update content
			if (initialContent) {
				await this.app.vault.modify(file, initialContent);
			}
		} else {
			// Check if file exists on disk but not indexed
			const adapter = this.app.vault.adapter;
			const fileExists = await adapter.exists(cachePath);
			
			if (fileExists) {
				console.log(`[SharedFileCacheManager] File exists on disk but not indexed, removing and recreating`);
				// Remove the unindexed file and create fresh
				await adapter.remove(cachePath);
			}
			
			console.log(`[SharedFileCacheManager] Creating new cache file`);
			// Create the file using vault API (ensures indexing)
			const createdFile = await this.app.vault.create(cachePath, initialContent);
			
			if (!createdFile) {
				console.error(`[SharedFileCacheManager] vault.create returned null`);
				throw new Error(`Failed to create cache file: vault.create returned null`);
			}
			
			file = createdFile;
			console.log(`[SharedFileCacheManager] File created: ${file.path}`);
		}

		if (!file) {
			throw new Error(`Failed to get or create cache file: ${cachePath}`);
		}

		const cached: CachedSharedFile = {
			cachePath,
			file,
			ownerId,
			resourcePath,
			docId,
		};

		this.cachedFiles.set(docId, cached);
		console.log(`[SharedFileCacheManager] Cache file ready: ${cachePath}`);
		return cached;
	}

	/**
	 * Update the content of a cached file.
	 */
	async updateCacheFile(docId: string, content: string): Promise<void> {
		const cached = this.cachedFiles.get(docId);
		if (!cached) {
			console.warn(`[SharedFileCacheManager] No cached file for docId: ${docId}`);
			return;
		}

		// Get the file (it may have been reloaded)
		const file = this.app.vault.getAbstractFileByPath(cached.cachePath);
		if (!(file instanceof TFile)) {
			console.warn(`[SharedFileCacheManager] Cache file no longer exists: ${cached.cachePath}`);
			this.cachedFiles.delete(docId);
			return;
		}

		// Update the file content
		await this.app.vault.modify(file, content);
	}

	/**
	 * Get the cached file info by docId.
	 */
	getCachedFile(docId: string): CachedSharedFile | undefined {
		return this.cachedFiles.get(docId);
	}

	/**
	 * Get the cached file info by cache file path.
	 */
	getCachedFileByPath(cachePath: string): CachedSharedFile | undefined {
		for (const cached of this.cachedFiles.values()) {
			if (cached.cachePath === cachePath) {
				return cached;
			}
		}
		return undefined;
	}

	/**
	 * Check if a file path is a shared file cache.
	 */
	isCacheFile(path: string): boolean {
		return path.startsWith(this.cacheDir + '/');
	}

	/**
	 * Remove a cached file.
	 */
	async removeCacheFile(docId: string): Promise<void> {
		const cached = this.cachedFiles.get(docId);
		if (!cached) return;

		try {
			const file = this.app.vault.getAbstractFileByPath(cached.cachePath);
			if (file instanceof TFile) {
				await this.app.vault.delete(file);
			}
		} catch (error) {
			console.warn(`[SharedFileCacheManager] Failed to delete cache file: ${cached.cachePath}`, error);
		}

		this.cachedFiles.delete(docId);
	}

	/**
	 * Clean up all cached files.
	 */
	async cleanup(): Promise<void> {
		// Delete all tracked cache files
		for (const cached of this.cachedFiles.values()) {
			try {
				const file = this.app.vault.getAbstractFileByPath(cached.cachePath);
				if (file instanceof TFile) {
					await this.app.vault.delete(file);
				}
			} catch (error) {
				// Ignore errors during cleanup
			}
		}
		this.cachedFiles.clear();

		// Also clean up any orphaned files in the cache directory
		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(this.cacheDir)) {
				const listing = await adapter.list(this.cacheDir);
				for (const filePath of listing.files) {
					try {
						await adapter.remove(filePath);
					} catch {
						// Ignore
					}
				}
			}
		} catch (error) {
			// Ignore errors during cleanup
		}
	}

	/**
	 * Sanitize a file name for use in the cache path.
	 */
	private sanitizeFileName(path: string): string {
		// Extract just the file name from the path
		const parts = path.split('/');
		let fileName = parts[parts.length - 1] || 'untitled';

		// Ensure it ends with .md
		if (!fileName.endsWith('.md')) {
			fileName = fileName + '.md';
		}

		// Remove any characters that are problematic for file systems
		fileName = fileName.replace(/[<>:"/\\|?*]/g, '_');

		// Limit length
		if (fileName.length > 100) {
			const ext = '.md';
			fileName = fileName.slice(0, 96) + ext;
		}

		return fileName;
	}
}
