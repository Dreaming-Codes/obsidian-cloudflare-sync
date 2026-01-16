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
