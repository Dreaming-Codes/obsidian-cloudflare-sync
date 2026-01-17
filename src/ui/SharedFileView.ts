/**
 * SharedFileView - Opens shared files using Obsidian's native MarkdownView.
 * 
 * Instead of a custom editor, this creates a temporary cache file and opens it
 * in Obsidian's standard MarkdownView, providing full editor functionality.
 */

import { MarkdownView, TFile, WorkspaceLeaf, Notice } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { ShareInvite } from '../types';

export const SHARED_FILE_VIEW_TYPE = 'cloudflare-sync-shared-file';

/**
 * Open a shared file in Obsidian's native MarkdownView using a cached local file.
 * 
 * This function:
 * 1. Creates/updates a cached local file in the plugin's cache directory
 * 2. Subscribes to real-time sync for the shared document
 * 3. Opens the cached file in MarkdownView
 */
export async function openSharedFile(plugin: CloudflareSyncPlugin, share: ShareInvite): Promise<void> {
	const { workspace } = plugin.app;
	
	console.log(`[openSharedFile] Opening shared file: ${share.resourcePath} from ${share.ownerId}`);

	// Ensure the cache manager is initialized
	const cacheManager = plugin.getSharedFileCacheManager();
	if (!cacheManager) {
		new Notice('Failed to initialize shared file cache');
		return;
	}

	// Start real-time sync if not already running
	let realtimeManager = plugin.getRealtimeSyncManager();
	if (!realtimeManager) {
		console.log('[openSharedFile] Starting real-time sync...');
		await plugin.startRealtimeSync();
		realtimeManager = plugin.getRealtimeSyncManager();
	}

	if (!realtimeManager) {
		new Notice('Failed to start real-time sync');
		return;
	}

	try {
		// Subscribe to the shared file to start receiving CRDT updates
		console.log('[openSharedFile] Subscribing to shared file...');
		await realtimeManager.subscribeToSharedFile(share.ownerId, share.resourcePath);

		// Wait a moment for initial sync
		await new Promise(resolve => setTimeout(resolve, 500));

		// Get the initial content from the CRDT
		const initialContent = realtimeManager.getActiveContent() || '';
		console.log(`[openSharedFile] Initial content length: ${initialContent.length}`);

		// Create or get the cached file
		const cached = await cacheManager.getOrCreateCacheFile(
			share.ownerId,
			share.resourcePath,
			initialContent
		);

		console.log(`[openSharedFile] Cache file created: ${cached.cachePath}`);

		// Store share metadata for this file so we can show it in the UI
		plugin.setSharedFileMetadata(cached.cachePath, share);

		// Set the cache file reference in the realtime manager so it can track edits
		realtimeManager.setActiveCacheFile(cached.file);

		// Get a fresh file reference from the vault to ensure it's valid
		const fileToOpen = plugin.app.vault.getAbstractFileByPath(cached.cachePath);
		if (!(fileToOpen instanceof TFile)) {
			console.error(`[openSharedFile] Cache file not found in vault: ${cached.cachePath}`);
			new Notice('Failed to open shared file: cache file not found');
			return;
		}

		console.log(`[openSharedFile] Opening file: ${fileToOpen.path}, basename: ${fileToOpen.basename}`);

		// Open the cached file in a new tab using MarkdownView
		const leaf = workspace.getLeaf('tab');
		await leaf.openFile(fileToOpen);

		// Focus the new leaf
		workspace.setActiveLeaf(leaf, { focus: true });

		console.log(`[openSharedFile] Opened cached file in MarkdownView, leaf type: ${leaf.view?.getViewType()}`);

	} catch (error) {
		console.error('[openSharedFile] Failed to open shared file:', error);
		new Notice(`Failed to open shared file: ${error}`);
	}
}

/**
 * Register the shared file view functionality.
 * This sets up event handlers for the cached shared files.
 */
export function registerSharedFileView(plugin: CloudflareSyncPlugin): void {
	// No custom view registration needed - we use native MarkdownView
	// The integration happens through the cache manager and real-time sync
	
	console.log('[registerSharedFileView] Shared file view registered (using native MarkdownView)');
}
