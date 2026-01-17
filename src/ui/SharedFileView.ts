/**
 * SharedFileView - A view for editing shared files in real-time collaboration.
 * 
 * This view opens shared files from other users and allows real-time collaborative
 * editing via WebSocket/CRDT sync.
 */

import { ItemView, WorkspaceLeaf, TextAreaComponent, Notice, debounce } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { ShareInvite } from '../types';

export const SHARED_FILE_VIEW_TYPE = 'cloudflare-sync-shared-file';

interface SharedFileViewState extends Record<string, unknown> {
	share?: ShareInvite;
}

export class SharedFileView extends ItemView {
	private plugin: CloudflareSyncPlugin;
	private share: ShareInvite | null = null;
	private editorContentEl: HTMLElement | null = null;
	private editorEl: HTMLTextAreaElement | null = null;
	private isUpdatingFromRemote = false;
	private unsubscribeHandler: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CloudflareSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SHARED_FILE_VIEW_TYPE;
	}

	getDisplayText(): string {
		if (this.share) {
			return `Shared: ${this.share.resourcePath}`;
		}
		return 'Shared File';
	}

	getIcon(): string {
		return 'share-2';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-shared-file-view');

		// Create header
		const header = contentEl.createDiv({ cls: 'shared-file-header' });
		header.createEl('h3', { text: 'Loading shared file...' });

		// Create content area
		this.editorContentEl = contentEl.createDiv({ cls: 'shared-file-content' });
	}

	async onClose(): Promise<void> {
		// Unsubscribe from the shared file
		if (this.unsubscribeHandler) {
			this.unsubscribeHandler();
			this.unsubscribeHandler = null;
		}

		// Clean up
		this.share = null;
		this.editorEl = null;
	}

	/**
	 * Set the shared file to display and edit.
	 */
	async setShare(share: ShareInvite): Promise<void> {
		this.share = share;
		await this.renderContent();
	}

	/**
	 * Get the current state for persistence.
	 */
	getState(): SharedFileViewState | Record<string, never> {
		if (this.share) {
			return { share: this.share };
		}
		return {};
	}

	/**
	 * Restore state from persistence.
	 */
	async setState(state: SharedFileViewState, _result: unknown): Promise<void> {
		if (state.share) {
			await this.setShare(state.share);
		}
	}

	private async renderContent(): Promise<void> {
		if (!this.share) return;

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-shared-file-view');

		// Header with file info
		const header = contentEl.createDiv({ cls: 'shared-file-header' });
		header.createEl('h3', { text: this.share.resourcePath });
		
		const meta = header.createDiv({ cls: 'shared-file-meta' });
		meta.createEl('span', { 
			text: `Shared by ${this.share.ownerEmail}`,
			cls: 'shared-file-owner' 
		});
		meta.createEl('span', { text: ' · ' });
		meta.createEl('span', { 
			text: this.getPermissionLabel(this.share.permission),
			cls: `shared-file-permission permission-${this.share.permission}` 
		});

		// Status indicator
		const statusEl = header.createDiv({ cls: 'shared-file-status' });
		statusEl.createEl('span', { text: 'Connecting...', cls: 'status-text connecting' });

		// Content area
		this.editorContentEl = contentEl.createDiv({ cls: 'shared-file-content' });

		// Create editor
		const editorContainer = this.editorContentEl.createDiv({ cls: 'shared-file-editor-container' });
		
		if (this.share.permission === 'viewer') {
			// Read-only view
			const viewerEl = editorContainer.createDiv({ cls: 'shared-file-viewer' });
			viewerEl.createEl('p', { text: 'Loading content...', cls: 'loading-text' });
		} else {
			// Editable textarea
			this.editorEl = editorContainer.createEl('textarea', {
				cls: 'shared-file-editor',
				attr: {
					placeholder: 'Loading content...',
					spellcheck: 'true',
				}
			});
			
			// Set up change handler with debounce
			const handleChange = debounce(() => {
				if (!this.isUpdatingFromRemote && this.editorEl) {
					this.handleLocalEdit(this.editorEl.value);
				}
			}, 100, true);

			this.editorEl.addEventListener('input', handleChange);
		}

		// Connect to real-time sync
		await this.connectToSharedFile(statusEl);
	}

	private async connectToSharedFile(statusEl: HTMLElement): Promise<void> {
		if (!this.share) return;

		const realtimeManager = this.plugin.getRealtimeSyncManager();
		
		if (!realtimeManager) {
			// Start real-time sync if not running
			await this.plugin.startRealtimeSync();
		}

		const manager = this.plugin.getRealtimeSyncManager();
		if (!manager) {
			this.showError('Failed to connect to real-time sync');
			return;
		}

		// Subscribe to the shared file
		try {
			await manager.subscribeToSharedFile(this.share.ownerId, this.share.resourcePath);

			// Update status
			const statusText = statusEl.querySelector('.status-text');
			if (statusText) {
				statusText.removeClass('connecting');
				statusText.addClass('connected');
				statusText.textContent = 'Connected';
			}

			// Set up content update listener
			this.unsubscribeHandler = () => {
				// Unsubscribe when view closes
				const m = this.plugin.getRealtimeSyncManager();
				// Note: The manager will handle cleanup when we switch files
			};

			// Poll for content updates (TODO: use proper event subscription)
			const pollContent = () => {
				if (!this.share) return;
				
				const m = this.plugin.getRealtimeSyncManager();
				if (!m) return;

				const content = m.getActiveContent();
				if (content !== null) {
					this.updateEditorContent(content);
				}
			};

			// Initial content load
			setTimeout(pollContent, 500);

			// Set up polling for updates (temporary - should use events)
			const pollInterval = window.setInterval(pollContent, 1000);
			this.register(() => window.clearInterval(pollInterval));

		} catch (error) {
			console.error('Failed to connect to shared file:', error);
			this.showError('Failed to connect to shared file');
		}
	}

	private updateEditorContent(content: string): void {
		if (this.share?.permission === 'viewer') {
			// Update viewer
			const viewer = this.editorContentEl?.querySelector('.shared-file-viewer');
			if (viewer instanceof HTMLElement) {
				viewer.empty();
				viewer.createEl('pre', { text: content, cls: 'shared-file-content-text' });
			}
		} else if (this.editorEl) {
			// Update editor if content differs
			if (this.editorEl.value !== content) {
				this.isUpdatingFromRemote = true;
				const scrollTop = this.editorEl.scrollTop;
				const selectionStart = this.editorEl.selectionStart;
				const selectionEnd = this.editorEl.selectionEnd;
				
				this.editorEl.value = content;
				
				// Restore scroll and selection
				this.editorEl.scrollTop = scrollTop;
				this.editorEl.setSelectionRange(
					Math.min(selectionStart, content.length),
					Math.min(selectionEnd, content.length)
				);
				
				this.isUpdatingFromRemote = false;
			}
		}
	}

	private handleLocalEdit(content: string): void {
		const manager = this.plugin.getRealtimeSyncManager();
		if (!manager) return;

		// For now, we replace the entire content
		// TODO: Implement proper diff-based updates
		// This is a simplified approach - a production version would track
		// character-level changes and apply them to the CRDT
	}

	private showError(message: string): void {
		const { contentEl } = this;
		contentEl.empty();
		
		const errorEl = contentEl.createDiv({ cls: 'shared-file-error' });
		errorEl.createEl('p', { text: message });
		
		const retryBtn = errorEl.createEl('button', { text: 'Retry', cls: 'mod-cta' });
		retryBtn.addEventListener('click', () => {
			if (this.share) {
				this.renderContent();
			}
		});
	}

	private getPermissionLabel(permission: string): string {
		switch (permission) {
			case 'owner': return 'Owner';
			case 'editor': return 'Can edit';
			case 'commenter': return 'Can comment';
			case 'viewer': return 'Can view';
			default: return permission;
		}
	}
}

/**
 * Register the SharedFileView with Obsidian.
 */
export function registerSharedFileView(plugin: CloudflareSyncPlugin): void {
	plugin.registerView(
		SHARED_FILE_VIEW_TYPE,
		(leaf) => new SharedFileView(leaf, plugin)
	);
}

/**
 * Open a shared file in the SharedFileView.
 */
export async function openSharedFile(plugin: CloudflareSyncPlugin, share: ShareInvite): Promise<void> {
	const { workspace } = plugin.app;

	// Check if there's already a shared file view open
	let leaf = workspace.getLeavesOfType(SHARED_FILE_VIEW_TYPE)[0];

	if (!leaf) {
		// Create a new leaf in the main area
		leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: SHARED_FILE_VIEW_TYPE,
			active: true,
		});
	}

	// Set the share on the view
	const view = leaf.view as SharedFileView;
	await view.setShare(share);

	// Reveal the leaf
	workspace.revealLeaf(leaf);
}
