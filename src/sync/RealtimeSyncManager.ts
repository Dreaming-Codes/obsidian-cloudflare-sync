/**
 * Real-time Sync Manager that integrates WebSocket, CRDT, and Obsidian editor.
 * Handles bidirectional sync between the editor and remote collaborators.
 */

import { App, Editor, MarkdownView, TFile, Events, debounce } from 'obsidian';
import { WebSocketClient, decodeBase64 } from './WebSocketClient';
import { CRDTDocument, CRDTDocumentManager } from './CRDTDocument';
import { SharedFileCacheManager, generateDocId } from './SharedFileCacheManager';
import type { ServerMessage, ConnectionStatus } from '../types';

export interface RealtimeSyncManagerConfig {
	app: App;
	serverUrl: string;
	getToken: () => Promise<string | null>;
	getUserId: () => string | null;
	getCacheManager: () => SharedFileCacheManager | null;
	onStatusChange?: (status: ConnectionStatus) => void;
	onCollaboratorJoin?: (docId: string, userId: string, email: string) => void;
	onCollaboratorLeave?: (docId: string, userId: string) => void;
}

/**
 * Information about an active document subscription.
 */
interface ActiveDocument {
	docId: string;
	/** The file being edited (owner's file or cache file) */
	file: TFile | null;
	/** Owner's user ID */
	ownerId: string;
	/** Original resource path */
	resourcePath: string;
	/** Whether this is a shared file (not owned by current user) */
	isShared: boolean;
	/** Last known content to detect changes */
	lastContent: string;
}

export class RealtimeSyncManager extends Events {
	private app: App;
	private wsClient: WebSocketClient;
	private crdtManager: CRDTDocumentManager;
	private config: RealtimeSyncManagerConfig;
	private activeDoc: ActiveDocument | null = null;
	private isUpdatingEditor = false;
	private isUpdatingFromEditor = false;
	private enabled = false;

	constructor(config: RealtimeSyncManagerConfig) {
		super();
		this.app = config.app;
		this.config = config;

		// Initialize CRDT manager
		this.crdtManager = new CRDTDocumentManager(
			(docId, update) => this.handleLocalUpdate(docId, update),
			(docId) => this.handleRemoteUpdate(docId)
		);

		// Initialize WebSocket client
		this.wsClient = new WebSocketClient({
			serverUrl: config.serverUrl,
			getToken: config.getToken,
			onMessage: (msg) => this.handleServerMessage(msg),
			onStatusChange: (status) => {
				config.onStatusChange?.(status);
				this.trigger('status-change', status);
			},
		});
	}

	/**
	 * Enable real-time sync.
	 */
	async enable(): Promise<void> {
		if (this.enabled) return;
		this.enabled = true;
	}

	/**
	 * Disable real-time sync.
	 */
	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;

		// Disconnect WebSocket
		this.wsClient.disconnect();

		// Unsubscribe from current document
		if (this.activeDoc) {
			this.wsClient.unsubscribe(this.activeDoc.docId);
		}

		// Clear state
		this.activeDoc = null;
		this.crdtManager.destroyAll();
	}

	/**
	 * Destroy the manager and clean up resources.
	 */
	destroy(): void {
		this.disable();
		this.wsClient.destroy();
	}

	/**
	 * Get the current connection status.
	 */
	getStatus(): ConnectionStatus {
		return this.wsClient.getStatus();
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.wsClient.isConnected();
	}

	/**
	 * Get the active document ID.
	 */
	getActiveDocId(): string | null {
		return this.activeDoc?.docId ?? null;
	}

	/**
	 * Subscribe to a file for real-time sync.
	 * This subscribes to the current user's own file.
	 */
	async subscribeToFile(file: TFile): Promise<void> {
		if (!this.enabled) return;
		if (!file.path.endsWith('.md')) return; // Only markdown files

		const userId = this.config.getUserId();
		if (!userId) {
			console.warn('[RealtimeSyncManager] Cannot subscribe: no user ID');
			return;
		}

		// Check if this is a shared cache file
		const cacheManager = this.config.getCacheManager();
		if (cacheManager?.isCacheFile(file.path)) {
			// This is a shared cache file - it's already subscribed via subscribeToSharedFile
			const cached = cacheManager.getCachedFileByPath(file.path);
			if (cached && this.activeDoc?.docId === cached.docId) {
				console.log(`[RealtimeSyncManager] Already subscribed to shared file: ${file.path}`);
				return;
			}
			// If it's a different cached file, we need to look up the share info
			// For now, just skip to avoid issues
			console.log(`[RealtimeSyncManager] Cache file opened but no active subscription: ${file.path}`);
			return;
		}

		const docId = await generateDocId(userId, file.path);

		// If already subscribed to this doc, don't resubscribe
		if (this.activeDoc?.docId === docId) {
			return;
		}

		// Unsubscribe from previous document
		if (this.activeDoc) {
			this.wsClient.unsubscribe(this.activeDoc.docId);
		}

		// Read current file content
		const content = await this.app.vault.read(file);

		// Get or create CRDT document
		const crdtDoc = this.crdtManager.getOrCreate(docId);

		// Initialize CRDT with current content if empty
		if (crdtDoc.getContent() === '') {
			crdtDoc.setContent(content);
		}

		// Set up active document
		this.activeDoc = {
			docId,
			file,
			ownerId: userId,
			resourcePath: file.path,
			isShared: false,
			lastContent: content,
		};

		// Connect to WebSocket for this document
		await this.wsClient.connect(docId);

		// Subscribe via WebSocket
		this.wsClient.subscribe(docId);

		// Send our state vector to get missing updates
		this.wsClient.sendSyncStep1(docId, crdtDoc.getStateVector());

		console.log(`[RealtimeSyncManager] Subscribed to own file ${file.path} (${docId})`);
	}

	/**
	 * Subscribe to a shared file for real-time collaboration.
	 * This connects to another user's document.
	 */
	async subscribeToSharedFile(ownerId: string, resourcePath: string): Promise<void> {
		console.log(`[RealtimeSyncManager] subscribeToSharedFile: owner=${ownerId}, path=${resourcePath}`);
		if (!this.enabled) return;

		const docId = await generateDocId(ownerId, resourcePath);
		console.log(`[RealtimeSyncManager] Generated docId: ${docId}`);

		// If already subscribed to this doc, don't resubscribe
		if (this.activeDoc?.docId === docId) {
			console.log(`[RealtimeSyncManager] Already subscribed to this doc`);
			return;
		}

		// Unsubscribe from previous document
		if (this.activeDoc) {
			this.wsClient.unsubscribe(this.activeDoc.docId);
		}

		// Get or create CRDT document (starts empty, will sync from server)
		const crdtDoc = this.crdtManager.getOrCreate(docId);

		// Set up active document (file will be set later when cache is created)
		this.activeDoc = {
			docId,
			file: null,
			ownerId,
			resourcePath,
			isShared: true,
			lastContent: '',
		};

		// Connect to WebSocket for this document
		console.log(`[RealtimeSyncManager] Connecting WebSocket...`);
		await this.wsClient.connect(docId);
		console.log(`[RealtimeSyncManager] WebSocket connected`);

		// Subscribe via WebSocket
		this.wsClient.subscribe(docId);
		console.log(`[RealtimeSyncManager] Sent subscribe message`);

		// Send our state vector to get the full document
		this.wsClient.sendSyncStep1(docId, crdtDoc.getStateVector());
		console.log(`[RealtimeSyncManager] Sent SyncStep1`);

		console.log(`[RealtimeSyncManager] Subscribed to shared file ${resourcePath} from ${ownerId}`);
	}

	/**
	 * Get the current CRDT content for the active document.
	 */
	getActiveContent(): string | null {
		if (!this.activeDoc) return null;
		const crdtDoc = this.crdtManager.get(this.activeDoc.docId);
		return crdtDoc?.getContent() ?? null;
	}

	/**
	 * Set the entire content of the active CRDT document.
	 * This replaces all content - use for simple editors without character-level tracking.
	 */
	setActiveContent(content: string): void {
		if (!this.activeDoc) return;

		const crdtDoc = this.crdtManager.get(this.activeDoc.docId);
		if (!crdtDoc) return;

		crdtDoc.setContent(content);
		this.activeDoc.lastContent = content;
	}

	/**
	 * Handle an editor change event from the active MarkdownView.
	 * Call this from the main plugin's editor-change handler.
	 */
	handleEditorChange(editor: Editor, file: TFile): void {
		if (!this.activeDoc || this.isUpdatingEditor) return;

		// Check if this is the file we're tracking
		if (!this.activeDoc.file) return;
		if (this.activeDoc.file.path !== file.path) return;

		// Get the current content
		const content = editor.getValue();

		// Skip if content hasn't changed
		if (content === this.activeDoc.lastContent) return;

		// Update CRDT with new content
		this.isUpdatingFromEditor = true;
		try {
			const crdtDoc = this.crdtManager.get(this.activeDoc.docId);
			if (crdtDoc) {
				crdtDoc.setContent(content);
				this.activeDoc.lastContent = content;
			}
		} finally {
			this.isUpdatingFromEditor = false;
		}
	}

	/**
	 * Set the cache file reference for a shared document.
	 * Called after the cache file is created.
	 */
	setActiveCacheFile(file: TFile): void {
		if (this.activeDoc) {
			this.activeDoc.file = file;
		}
	}

	// ========== Private Methods ==========

	private handleLocalUpdate(docId: string, update: Uint8Array): void {
		if (!this.wsClient.isConnected()) return;
		if (this.isUpdatingEditor) return; // Don't send updates triggered by remote changes

		// Send update to server
		console.log(`[RealtimeSyncManager] Sending local update for ${docId}, size: ${update.length}`);
		this.wsClient.sendUpdate(docId, update);
	}

	private handleRemoteUpdate(docId: string): void {
		if (!this.activeDoc || docId !== this.activeDoc.docId) return;

		const crdtDoc = this.crdtManager.get(docId);
		if (!crdtDoc) return;

		const content = crdtDoc.getContent();
		console.log(`[RealtimeSyncManager] Remote update received, content length: ${content.length}`);

		// Update last known content
		this.activeDoc.lastContent = content;

		// Emit event for external listeners
		this.trigger('content-change', docId, content);

		// Update the editor if it's showing this file
		this.updateEditorContent(content);

		// For shared files, also update the cache file
		if (this.activeDoc.isShared) {
			this.updateCacheFile(docId, content);
		}
	}

	private updateEditorContent(content: string): void {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) return;

		// Check if the active view is showing our file
		if (!this.activeDoc?.file) return;
		if (activeView.file.path !== this.activeDoc.file.path) return;

		const editor = activeView.editor;
		if (!editor) return;

		// Prevent feedback loop
		this.isUpdatingEditor = true;

		try {
			const currentContent = editor.getValue();
			if (currentContent !== content) {
				// Save cursor position
				const cursor = editor.getCursor();

				// Replace content
				editor.setValue(content);

				// Restore cursor (adjust if beyond new content length)
				const lines = content.split('\n');
				const maxLine = lines.length - 1;
				const line = Math.min(cursor.line, maxLine);
				const maxCh = lines[line]?.length ?? 0;
				const ch = Math.min(cursor.ch, maxCh);
				editor.setCursor({ line, ch });
			}
		} finally {
			this.isUpdatingEditor = false;
		}
	}

	private async updateCacheFile(docId: string, content: string): Promise<void> {
		const cacheManager = this.config.getCacheManager();
		if (!cacheManager) return;

		try {
			await cacheManager.updateCacheFile(docId, content);
		} catch (error) {
			console.error(`[RealtimeSyncManager] Failed to update cache file:`, error);
		}
	}

	private handleServerMessage(message: ServerMessage): void {
		switch (message.type) {
			case 'subscribed':
				console.log(`[RealtimeSyncManager] Subscribed to ${message.doc_id}`);
				break;

			case 'sync_step2': {
				// Server sent us updates we're missing
				console.log(`[RealtimeSyncManager] Received sync_step2 for ${message.doc_id}, update length: ${message.update.length}`);
				const crdtDoc = this.crdtManager.get(message.doc_id);
				if (crdtDoc) {
					const update = decodeBase64(message.update);
					console.log(`[RealtimeSyncManager] Decoded update length: ${update.length}`);
					if (update.length > 0) {
						crdtDoc.applyRemoteUpdate(update);
					}
					// Emit content-change for initial sync
					const content = crdtDoc.getContent();
					console.log(`[RealtimeSyncManager] CRDT content after sync: "${content.substring(0, 100)}..." (${content.length} chars)`);
					
					// Update last known content
					if (this.activeDoc && this.activeDoc.docId === message.doc_id) {
						this.activeDoc.lastContent = content;
					}
					
					this.trigger('content-change', message.doc_id, content);
				}
				break;
			}

			case 'update': {
				// Another user sent an update
				console.log(`[RealtimeSyncManager] Received update from ${message.from_user} for ${message.doc_id}`);
				const crdtDoc = this.crdtManager.get(message.doc_id);
				if (crdtDoc) {
					const update = decodeBase64(message.update);
					crdtDoc.applyRemoteUpdate(update);
				}
				break;
			}

			case 'user_joined':
				console.log(`[RealtimeSyncManager] ${message.email} joined ${message.doc_id}`);
				this.config.onCollaboratorJoin?.(message.doc_id, message.user_id, message.email);
				this.trigger('collaborator-join', message);
				break;

			case 'user_left':
				console.log(`[RealtimeSyncManager] ${message.user_id} left ${message.doc_id}`);
				this.config.onCollaboratorLeave?.(message.doc_id, message.user_id);
				this.trigger('collaborator-leave', message);
				break;

			case 'error':
				console.error(`[RealtimeSyncManager] Server error: ${message.code} - ${message.message}`);
				break;

			default:
				// Ignore other message types
				break;
		}
	}
}
