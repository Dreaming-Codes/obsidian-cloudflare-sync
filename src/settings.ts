import { App, PluginSettingTab, Setting } from 'obsidian';
import type CloudflareSyncPlugin from './main';
import { PendingSharesModal, SharedWithMeModal } from './sharing/ShareModal';
import type { ConnectionStatus, SyncStatus } from './types';

// ============================================================================
// Settings Interface
// ============================================================================

export interface CloudflareSyncSettings {
	/** Server URL for the sync backend */
	serverUrl: string;
	/** User's email (read-only after auth) */
	userEmail: string | null;
	/** User's ID from the backend */
	userId: string | null;
	/** Whether sync is enabled */
	syncEnabled: boolean;
	/** JWT authentication token */
	authToken: string | null;
	/** Token expiry timestamp (seconds since epoch) */
	tokenExpiry: number | null;
	/** Refresh token for obtaining new JWTs */
	refreshToken: string | null;
}

export const DEFAULT_SETTINGS: CloudflareSyncSettings = {
	serverUrl: 'https://sync.elysiumcraftrp.org',
	userEmail: null,
	userId: null,
	syncEnabled: true,
	authToken: null,
	tokenExpiry: null,
	refreshToken: null,
};

// ============================================================================
// Settings Tab
// ============================================================================

export class CloudflareSyncSettingTab extends PluginSettingTab {
	plugin: CloudflareSyncPlugin;

	constructor(app: App, plugin: CloudflareSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Header
		containerEl.createEl('h2', { text: 'Cloudflare Sync' });

		// Connection Status Section
		this.renderConnectionStatus(containerEl);

		// Server Settings Section
		containerEl.createEl('h3', { text: 'Server' });
		this.renderServerSettings(containerEl);

		// Authentication Section
		containerEl.createEl('h3', { text: 'Authentication' });
		this.renderAuthSection(containerEl);

		// Sync Settings Section
		containerEl.createEl('h3', { text: 'Sync' });
		this.renderSyncSettings(containerEl);

		// Sharing Section (only when logged in)
		if (this.plugin.settings.authToken) {
			containerEl.createEl('h3', { text: 'Sharing' });
			this.renderSharingSettings(containerEl);
		}
	}

	private renderConnectionStatus(containerEl: HTMLElement): void {
		const statusContainer = containerEl.createDiv({ cls: 'cloudflare-sync-status' });

		const connectionStatus = this.plugin.getConnectionStatus();
		const syncStatus = this.plugin.getSyncStatus();

		const statusText = this.getStatusText(connectionStatus, syncStatus);
		const statusClass = this.getStatusClass(connectionStatus);

		const statusEl = statusContainer.createDiv({ cls: `status-indicator ${statusClass}` });
		statusEl.createSpan({ text: statusText });
	}

	private getStatusText(connection: ConnectionStatus, sync: SyncStatus): string {
		if (!this.plugin.settings.authToken) {
			return 'Not logged in';
		}

		switch (connection) {
			case 'connected':
				switch (sync) {
					case 'syncing':
						return 'Syncing...';
					case 'error':
						return 'Sync error';
					case 'offline':
						return 'Offline (changes queued)';
					default:
						return 'Connected';
				}
			case 'connecting':
				return 'Connecting...';
			case 'error':
				return 'Connection error';
			default:
				return 'Disconnected';
		}
	}

	private getStatusClass(status: ConnectionStatus): string {
		switch (status) {
			case 'connected':
				return 'status-connected';
			case 'connecting':
				return 'status-connecting';
			case 'error':
				return 'status-error';
			default:
				return 'status-disconnected';
		}
	}

	private renderServerSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('The URL of your Cloudflare Sync backend')
			.addText((text) =>
				text
					.setPlaceholder('https://sync.example.com')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						// Validate URL format
						try {
							new URL(value);
							this.plugin.settings.serverUrl = value.replace(/\/$/, ''); // Remove trailing slash
							await this.plugin.saveSettings();
						} catch {
							// Invalid URL, don't save
						}
					}),
			);
	}

	private renderAuthSection(containerEl: HTMLElement): void {
		const isLoggedIn = !!this.plugin.settings.authToken;

		if (isLoggedIn) {
			// Show logged in state
			new Setting(containerEl)
				.setName('Logged in as')
				.setDesc(this.plugin.settings.userEmail ?? 'Unknown')
				.addButton((button) =>
					button
						.setButtonText('Logout')
						.setWarning()
						.onClick(async () => {
							await this.plugin.authManager.logout();
							this.display(); // Refresh the settings tab
						}),
				);

			// Logout from all devices option
			new Setting(containerEl).setName('Security').addButton((button) =>
				button
					.setButtonText('Logout from all devices')
					.setWarning()
					.onClick(async () => {
						await this.plugin.authManager.logoutAll();
						this.display();
					}),
			);
		} else {
			// Show login button
			new Setting(containerEl)
				.setName('Login')
				.setDesc('Sign in with your email to start syncing')
				.addButton((button) =>
					button.setButtonText('Login with email').onClick(() => {
						this.plugin.openMagicLinkModal();
					}),
				);
		}
	}

	private renderSyncSettings(containerEl: HTMLElement): void {
		const isLoggedIn = !!this.plugin.settings.authToken;

		new Setting(containerEl)
			.setName('Enable sync')
			.setDesc('Automatically sync changes with the server')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncEnabled)
					.setDisabled(!isLoggedIn)
					.onChange(async (value) => {
						this.plugin.settings.syncEnabled = value;
						await this.plugin.saveSettings();

						if (value) {
							await this.plugin.startSync();
						} else {
							await this.plugin.stopSync();
						}
					}),
			);

		if (isLoggedIn) {
			new Setting(containerEl).setName('Manual sync').setDesc('Trigger a full sync now').addButton((button) =>
				button
					.setButtonText('Sync now')
					.setDisabled(!this.plugin.settings.syncEnabled)
					.onClick(async () => {
						await this.plugin.triggerManualSync();
					}),
			);

			new Setting(containerEl)
				.setName('Force re-upload all')
				.setDesc('Clear remote data and re-upload all local files. Use this to fix sync issues.')
				.addButton((button) =>
					button
						.setButtonText('Re-upload all')
						.setWarning()
						.setDisabled(!this.plugin.settings.syncEnabled)
						.onClick(async () => {
							// Confirm before proceeding
							const confirmed = confirm(
								'This will clear all remote file metadata and re-upload all local files. ' +
								'This operation may take a while for large vaults.\n\n' +
								'Are you sure you want to continue?'
							);
							if (confirmed) {
								await this.plugin.triggerForceReupload();
							}
						}),
				);
		}
	}

	private renderSharingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Shared with me')
			.setDesc('View and download files others have shared with you')
			.addButton((button) =>
				button
					.setButtonText('View shared files')
					.setCta()
					.onClick(() => {
						new SharedWithMeModal(this.plugin).open();
					}),
			);

		new Setting(containerEl)
			.setName('Pending invitations')
			.setDesc('View pending share invitations')
			.addButton((button) =>
				button
					.setButtonText('View invitations')
					.onClick(() => {
						new PendingSharesModal(this.plugin).open();
					}),
			);
	}
}
