/**
 * ShareModal - UI for sharing files and folders with other users.
 */

import { Modal, Setting, Notice, TFile, TFolder, TAbstractFile } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { Permission, ShareInvite } from '../types';
import { ShareManager } from './ShareManager';

export class ShareModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private shareManager: ShareManager;
	private resource: TAbstractFile;
	private shares: ShareInvite[] = [];
	private isLoading = false;

	constructor(plugin: CloudflareSyncPlugin, resource: TAbstractFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.shareManager = new ShareManager(plugin);
		this.resource = resource;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-share-modal');

		// Title
		const isFolder = this.resource instanceof TFolder;
		contentEl.createEl('h2', {
			text: `Share ${isFolder ? 'folder' : 'file'}: ${this.resource.name}`,
		});

		// Loading state
		this.isLoading = true;
		this.renderContent();

		// Load existing shares
		await this.loadShares();
		this.isLoading = false;
		this.renderContent();
	}

	private async loadShares(): Promise<void> {
		this.shares = await this.shareManager.getSharesForResource(this.resource.path);
	}

	private renderContent(): void {
		const { contentEl } = this;
		const container = contentEl.querySelector('.share-content') as HTMLElement | null;
		if (container) {
			container.empty();
		}

		const content = container || contentEl.createDiv({ cls: 'share-content' });
		content.empty();

		if (this.isLoading) {
			content.createEl('p', { text: 'Loading...', cls: 'share-loading' });
			return;
		}

		// Add new share section
		this.renderAddShareSection(content);

		// Existing shares section
		if (this.shares.length > 0) {
			this.renderExistingShares(content);
		}
	}

	private renderAddShareSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'share-add-section' });
		section.createEl('h3', { text: 'Add collaborator' });

		let emailInput: HTMLInputElement;
		let permissionSelect: HTMLSelectElement;

		// Email input
		new Setting(section)
			.setName('Email address')
			.setDesc('Enter the email of the person you want to share with')
			.addText((text) => {
				emailInput = text.inputEl;
				text.setPlaceholder('email@example.com');
			});

		// Permission dropdown
		new Setting(section)
			.setName('Permission')
			.setDesc('Choose what they can do')
			.addDropdown((dropdown) => {
				permissionSelect = dropdown.selectEl;
				dropdown
					.addOption('editor', 'Can edit')
					.addOption('commenter', 'Can comment')
					.addOption('viewer', 'Can view')
					.setValue('editor');
			});

		// Add button
		new Setting(section).addButton((button) => {
			button
				.setButtonText('Share')
				.setCta()
				.onClick(async () => {
					const email = emailInput.value.trim();
					const permission = permissionSelect.value as Permission;

					if (!email) {
						new Notice('Please enter an email address');
						return;
					}

					if (!this.isValidEmail(email)) {
						new Notice('Please enter a valid email address');
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Sharing...');

					const isFolder = this.resource instanceof TFolder;
					const share = await this.shareManager.createShare(
						this.resource.path,
						isFolder ? 'folder' : 'file',
						email,
						permission
					);

					if (share) {
						new Notice(`Shared with ${email}`);
						emailInput.value = '';
						await this.loadShares();
						this.renderContent();
					} else {
						new Notice('Failed to share. Please try again.');
					}

					button.setDisabled(false);
					button.setButtonText('Share');
				});
		});
	}

	private renderExistingShares(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'share-existing-section' });
		section.createEl('h3', { text: 'Shared with' });

		for (const share of this.shares) {
			this.renderShareItem(section, share);
		}
	}

	private renderShareItem(container: HTMLElement, share: ShareInvite): void {
		const item = container.createDiv({ cls: 'share-item' });

		// Email and status
		const info = item.createDiv({ cls: 'share-item-info' });
		info.createEl('span', { text: share.inviteeEmail, cls: 'share-email' });

		if (!share.acceptedAt) {
			info.createEl('span', { text: 'Pending', cls: 'share-status pending' });
		}

		// Permission dropdown and remove button
		const controls = item.createDiv({ cls: 'share-item-controls' });

		// Permission dropdown
		const select = controls.createEl('select', { cls: 'share-permission-select' });
		for (const perm of this.shareManager.getShareablePermissions()) {
			const option = select.createEl('option', {
				text: this.shareManager.getPermissionLabel(perm),
				value: perm,
			});
			if (perm === share.permission) {
				option.selected = true;
			}
		}

		select.addEventListener('change', async () => {
			const newPermission = select.value as Permission;
			const updated = await this.shareManager.updateShare(share.id, newPermission);
			if (updated) {
				new Notice(`Updated permission for ${share.inviteeEmail}`);
				await this.loadShares();
			} else {
				new Notice('Failed to update permission');
				select.value = share.permission;
			}
		});

		// Remove button
		const removeBtn = controls.createEl('button', {
			text: 'Remove',
			cls: 'share-remove-btn',
		});
		removeBtn.addEventListener('click', async () => {
			removeBtn.disabled = true;
			removeBtn.textContent = 'Removing...';

			const success = await this.shareManager.deleteShare(share.id);
			if (success) {
				new Notice(`Removed ${share.inviteeEmail}`);
				await this.loadShares();
				this.renderContent();
			} else {
				new Notice('Failed to remove share');
				removeBtn.disabled = false;
				removeBtn.textContent = 'Remove';
			}
		});
	}

	private isValidEmail(email: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * PendingSharesModal - Shows shares that need to be accepted.
 */
export class PendingSharesModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private shareManager: ShareManager;
	private pendingShares: ShareInvite[] = [];
	private isLoading = false;

	constructor(plugin: CloudflareSyncPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.shareManager = new ShareManager(plugin);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-pending-modal');

		contentEl.createEl('h2', { text: 'Pending invitations' });

		this.isLoading = true;
		this.renderContent();

		this.pendingShares = await this.shareManager.getPendingShares();
		this.isLoading = false;
		this.renderContent();
	}

	private renderContent(): void {
		const { contentEl } = this;
		const container = contentEl.querySelector('.pending-content') as HTMLElement | null;
		if (container) {
			container.empty();
		}

		const content = container || contentEl.createDiv({ cls: 'pending-content' });
		content.empty();

		if (this.isLoading) {
			content.createEl('p', { text: 'Loading...', cls: 'pending-loading' });
			return;
		}

		if (this.pendingShares.length === 0) {
			content.createEl('p', { text: 'No pending invitations', cls: 'pending-empty' });
			return;
		}

		for (const share of this.pendingShares) {
			this.renderPendingItem(content, share);
		}
	}

	private renderPendingItem(container: HTMLElement, share: ShareInvite): void {
		const item = container.createDiv({ cls: 'pending-item' });

		// Info
		const info = item.createDiv({ cls: 'pending-item-info' });
		info.createEl('div', {
			text: `${share.ownerEmail} shared "${share.resourcePath}"`,
			cls: 'pending-description',
		});
		info.createEl('div', {
			text: `Permission: ${this.shareManager.getPermissionLabel(share.permission)}`,
			cls: 'pending-permission',
		});

		// Accept button
		const controls = item.createDiv({ cls: 'pending-item-controls' });
		const acceptBtn = controls.createEl('button', {
			text: 'Accept',
			cls: 'pending-accept-btn mod-cta',
		});
		acceptBtn.addEventListener('click', async () => {
			acceptBtn.disabled = true;
			acceptBtn.textContent = 'Accepting...';

			const success = await this.shareManager.acceptShare(share.id);
			if (success) {
				new Notice('Share accepted');
				this.pendingShares = this.pendingShares.filter((s) => s.id !== share.id);
				this.renderContent();
			} else {
				new Notice('Failed to accept share');
				acceptBtn.disabled = false;
				acceptBtn.textContent = 'Accept';
			}
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * SharedWithMeModal - Shows files/folders shared with the current user.
 */
export class SharedWithMeModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private shareManager: ShareManager;
	private shares: ShareInvite[] = [];
	private isLoading = false;

	constructor(plugin: CloudflareSyncPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.shareManager = new ShareManager(plugin);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-shared-modal');

		contentEl.createEl('h2', { text: 'Shared with me' });

		this.isLoading = true;
		this.renderContent();

		// Get all shares (both pending and accepted)
		this.shares = await this.shareManager.getSharedWithMe();
		this.isLoading = false;
		this.renderContent();
	}

	private renderContent(): void {
		const { contentEl } = this;
		const container = contentEl.querySelector('.shared-content') as HTMLElement | null;
		if (container) {
			container.empty();
		}

		const content = container || contentEl.createDiv({ cls: 'shared-content' });
		content.empty();

		if (this.isLoading) {
			content.createEl('p', { text: 'Loading...', cls: 'shared-loading' });
			return;
		}

		if (this.shares.length === 0) {
			content.createEl('p', { text: 'No files have been shared with you yet.', cls: 'shared-empty' });
			return;
		}

		// Separate pending and accepted shares
		const pending = this.shares.filter(s => !s.acceptedAt);
		const accepted = this.shares.filter(s => s.acceptedAt);

		if (pending.length > 0) {
			content.createEl('h3', { text: 'Pending invitations' });
			for (const share of pending) {
				this.renderPendingItem(content, share);
			}
		}

		if (accepted.length > 0) {
			content.createEl('h3', { text: 'Shared files' });
			for (const share of accepted) {
				this.renderAcceptedItem(content, share);
			}
		}
	}

	private renderPendingItem(container: HTMLElement, share: ShareInvite): void {
		const item = container.createDiv({ cls: 'shared-item pending' });

		const info = item.createDiv({ cls: 'shared-item-info' });
		info.createEl('div', {
			text: share.resourcePath,
			cls: 'shared-path',
		});
		info.createEl('div', {
			text: `From: ${share.ownerEmail} · ${this.shareManager.getPermissionLabel(share.permission)}`,
			cls: 'shared-meta',
		});

		const controls = item.createDiv({ cls: 'shared-item-controls' });
		const acceptBtn = controls.createEl('button', {
			text: 'Accept',
			cls: 'mod-cta',
		});
		acceptBtn.addEventListener('click', async () => {
			acceptBtn.disabled = true;
			acceptBtn.textContent = 'Accepting...';

			const success = await this.shareManager.acceptShare(share.id);
			if (success) {
				new Notice('Share accepted!');
				// Refresh the list
				this.shares = await this.shareManager.getSharedWithMe();
				this.renderContent();
			} else {
				new Notice('Failed to accept share');
				acceptBtn.disabled = false;
				acceptBtn.textContent = 'Accept';
			}
		});
	}

	private renderAcceptedItem(container: HTMLElement, share: ShareInvite): void {
		const item = container.createDiv({ cls: 'shared-item accepted' });

		const info = item.createDiv({ cls: 'shared-item-info' });
		info.createEl('div', {
			text: share.resourcePath,
			cls: 'shared-path',
		});
		info.createEl('div', {
			text: `From: ${share.ownerEmail} · ${this.shareManager.getPermissionLabel(share.permission)}`,
			cls: 'shared-meta',
		});

		const controls = item.createDiv({ cls: 'shared-item-controls' });
		
		// Download button
		const downloadBtn = controls.createEl('button', {
			text: 'Download',
			cls: 'mod-cta',
		});
		downloadBtn.addEventListener('click', async () => {
			downloadBtn.disabled = true;
			downloadBtn.textContent = 'Downloading...';

			try {
				const success = await this.downloadSharedFile(share);
				if (success) {
					new Notice(`Downloaded: ${share.resourcePath}`);
				} else {
					new Notice('Failed to download file');
				}
			} catch (e) {
				console.error('Download error:', e);
				new Notice('Failed to download file');
			}

			downloadBtn.disabled = false;
			downloadBtn.textContent = 'Download';
		});
	}

	private async downloadSharedFile(share: ShareInvite): Promise<boolean> {
		try {
			// Fetch the shared file from the server
			const response = await fetch(
				`${this.plugin.settings.serverUrl}/shared-files/${share.ownerId}/${encodeURIComponent(share.resourcePath)}`,
				{
					headers: this.plugin.authManager.getAuthHeader(),
				}
			);

			if (!response.ok) {
				console.error('Failed to download shared file:', response.status);
				return false;
			}

			const content = await response.arrayBuffer();

			// Determine where to save - use "Shared" folder
			const sharedFolder = 'Shared';
			const targetPath = `${sharedFolder}/${share.ownerEmail}/${share.resourcePath}`;

			// Ensure folders exist
			await this.ensureFolderExists(sharedFolder);
			await this.ensureFolderExists(`${sharedFolder}/${share.ownerEmail}`);

			// Get parent folder of the file if needed
			const pathParts = targetPath.split('/');
			pathParts.pop(); // Remove filename
			if (pathParts.length > 0) {
				await this.ensureFolderExists(pathParts.join('/'));
			}

			// Check if file already exists
			const existingFile = this.plugin.app.vault.getAbstractFileByPath(targetPath);
			if (existingFile instanceof TFile) {
				await this.plugin.app.vault.modifyBinary(existingFile, content);
			} else {
				await this.plugin.app.vault.createBinary(targetPath, content);
			}

			return true;
		} catch (e) {
			console.error('Error downloading shared file:', e);
			return false;
		}
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			try {
				await this.plugin.app.vault.createFolder(path);
			} catch {
				// Folder might already exist or parent needs to be created
				const parts = path.split('/');
				let currentPath = '';
				for (const part of parts) {
					currentPath = currentPath ? `${currentPath}/${part}` : part;
					const folder = this.plugin.app.vault.getAbstractFileByPath(currentPath);
					if (!folder) {
						await this.plugin.app.vault.createFolder(currentPath);
					}
				}
			}
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
