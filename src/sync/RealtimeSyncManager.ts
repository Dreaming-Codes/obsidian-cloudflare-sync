/**
 * Real-time Sync Manager that integrates WebSocket, CRDT, and Obsidian editor.
 * Handles bidirectional sync between the editor and remote collaborators.
 */

import { App, Editor, MarkdownView, TFile, Events } from 'obsidian';
import { WebSocketClient, decodeBase64 } from './WebSocketClient';
import { CRDTDocument, CRDTDocumentManager } from './CRDTDocument';
import type { ServerMessage, ConnectionStatus } from '../types';

export interface RealtimeSyncManagerConfig {
	app: App;
	serverUrl: string;
	getToken: () => Promise<string | null>;
	getUserId: () => string | null;
	onStatusChange?: (status: ConnectionStatus) => void;
	onCollaboratorJoin?: (docId: string, userId: string, email: string) => void;
	onCollaboratorLeave?: (docId: string, userId: string) => void;
}

/**
 * Generates a document ID from an owner ID and file path.
 * Format: {owner_id}:{path_hash}
 * This ensures files are globally unique across users.
 */
async function getDocId(ownerId: string, path: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(path);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const pathHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return `${ownerId}:${pathHash}`;
}

export class RealtimeSyncManager extends Events {
	private app: App;
	private wsClient: WebSocketClient;
	private crdtManager: CRDTDocumentManager;
	private config: RealtimeSyncManagerConfig;
	private activeFile: TFile | null = null;
	private activeDocId: string | null = null;
	private editorUpdateHandler: ((editor: Editor) => void) | null = null;
	private isUpdatingEditor = false;
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

		// Subscribe to active file if any (this will connect the WebSocket)
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file) {
			await this.subscribeToFile(activeView.file);
		}

		// Listen for file open events
		this.registerFileOpenHandler();
	}

	/**
	 * Disable real-time sync.
	 */
	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;

		// Disconnect WebSocket
		this.wsClient.disconnect();

		// Unsubscribe from current file
		if (this.activeDocId) {
			this.wsClient.unsubscribe(this.activeDocId);
		}

		// Clear state
		this.activeFile = null;
		this.activeDocId = null;
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

		this.activeFile = file;
		this.activeDocId = await getDocId(userId, file.path);

		// Get or create CRDT document
		const crdtDoc = this.crdtManager.getOrCreate(this.activeDocId);

		// Read current file content
		const content = await this.app.vault.read(file);

		// Initialize CRDT with current content if empty
		if (crdtDoc.getContent() === '') {
			crdtDoc.setContent(content);
		}

		// Connect to WebSocket for this document (will disconnect from previous if any)
		await this.wsClient.connect(this.activeDocId);

		// Subscribe via WebSocket
		this.wsClient.subscribe(this.activeDocId);

		// Send our state vector to get missing updates
		this.wsClient.sendSyncStep1(this.activeDocId, crdtDoc.getStateVector());

		console.log(`[RealtimeSyncManager] Subscribed to ${file.path} (${this.activeDocId})`);
	}

	/**
	 * Subscribe to a shared file for real-time collaboration.
	 * This connects to another user's document.
	 */
	async subscribeToSharedFile(ownerId: string, resourcePath: string): Promise<void> {
		if (!this.enabled) return;

		// Clear active file since this is a remote file
		this.activeFile = null;
		this.activeDocId = await getDocId(ownerId, resourcePath);

		// Get or create CRDT document (starts empty, will sync from server)
		const crdtDoc = this.crdtManager.getOrCreate(this.activeDocId);

		// Connect to WebSocket for this document (will disconnect from previous if any)
		await this.wsClient.connect(this.activeDocId);

		// Subscribe via WebSocket
		this.wsClient.subscribe(this.activeDocId);

		// Send our state vector to get the full document
		this.wsClient.sendSyncStep1(this.activeDocId, crdtDoc.getStateVector());

		console.log(`[RealtimeSyncManager] Subscribed to shared file ${resourcePath} from ${ownerId} (${this.activeDocId})`);
	}

	/**
	 * Get the current CRDT content for the active document.
	 */
	getActiveContent(): string | null {
		if (!this.activeDocId) return null;
		const crdtDoc = this.crdtManager.get(this.activeDocId);
		return crdtDoc?.getContent() ?? null;
	}

	/**
	 * Apply editor changes to CRDT.
	 */
	applyEditorChange(from: number, to: number, text: string): void {
		if (!this.activeDocId || this.isUpdatingEditor) return;

		const crdtDoc = this.crdtManager.get(this.activeDocId);
		if (!crdtDoc) return;

		crdtDoc.applyChange(from, to, text);
	}

	// ========== Private Methods ==========

	private registerFileOpenHandler(): void {
		// This would be called from the main plugin to register the event
		// The actual registration happens in the plugin's onload
	}

	private handleLocalUpdate(docId: string, update: Uint8Array): void {
		if (!this.wsClient.isConnected()) return;

		// Send update to server
		this.wsClient.sendUpdate(docId, update);
	}

	private handleRemoteUpdate(docId: string): void {
		if (docId !== this.activeDocId) return;

		const crdtDoc = this.crdtManager.get(docId);
		if (!crdtDoc) return;

		// Update editor with CRDT content
		this.updateEditorContent(crdtDoc.getContent());
	}

	private updateEditorContent(content: string): void {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

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

	private handleServerMessage(message: ServerMessage): void {
		switch (message.type) {
			case 'subscribed':
				console.log(`[RealtimeSyncManager] Subscribed to ${message.doc_id}`);
				break;

			case 'sync_step2': {
				// Server sent us updates we're missing
				const crdtDoc = this.crdtManager.get(message.doc_id);
				if (crdtDoc) {
					const update = decodeBase64(message.update);
					if (update.length > 0) {
						crdtDoc.applyRemoteUpdate(update);
					}
				}
				break;
			}

			case 'update': {
				// Another user sent an update
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
