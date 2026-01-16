import { Plugin } from 'obsidian';
import { AuthManager } from './auth/AuthManager';
import { MagicLinkModal } from './auth/MagicLinkModal';
import { CloudflareSyncSettingTab, CloudflareSyncSettings, DEFAULT_SETTINGS } from './settings';
import type { ConnectionStatus, SyncStatus } from './types';
import { NotificationManager } from './ui/NotificationManager';
import { StatusBar } from './ui/StatusBar';

/**
 * Cloudflare Sync Plugin for Obsidian
 *
 * Provides real-time collaborative sync using Cloudflare infrastructure:
 * - R2 for file storage
 * - Durable Objects for real-time sync
 * - Workers for API and authentication
 */
export default class CloudflareSyncPlugin extends Plugin {
	settings!: CloudflareSyncSettings;
	authManager!: AuthManager;
	notificationManager!: NotificationManager;
	private statusBar!: StatusBar;

	// Connection and sync state
	private connectionStatus: ConnectionStatus = 'disconnected';
	private syncStatus: SyncStatus = 'idle';

	async onload(): Promise<void> {
		// Load settings
		await this.loadSettings();

		// Initialize managers
		this.authManager = new AuthManager(this);
		this.notificationManager = new NotificationManager(this);
		this.statusBar = new StatusBar(this);

		// Initialize auth (check token validity, schedule refresh)
		await this.authManager.initialize();

		// Initialize status bar
		this.statusBar.initialize();

		// Add settings tab
		this.addSettingTab(new CloudflareSyncSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Start sync if enabled and authenticated
		if (this.settings.syncEnabled && this.authManager.isAuthenticated()) {
			// Defer sync start to allow Obsidian to fully load
			this.app.workspace.onLayoutReady(() => {
				this.startSync();
			});
		}
	}

	onunload(): void {
		// Clean up managers
		this.authManager?.cleanup();
		this.statusBar?.cleanup();

		// Stop any active sync
		this.stopSync();
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CloudflareSyncSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update status bar when settings change
		this.statusBar?.update();
	}

	// ============================================================================
	// Status Accessors
	// ============================================================================

	getConnectionStatus(): ConnectionStatus {
		return this.connectionStatus;
	}

	getSyncStatus(): SyncStatus {
		return this.syncStatus;
	}

	setConnectionStatus(status: ConnectionStatus): void {
		this.connectionStatus = status;
		this.statusBar?.update();
	}

	setSyncStatus(status: SyncStatus): void {
		this.syncStatus = status;
		this.statusBar?.update();
	}

	// ============================================================================
	// Authentication UI
	// ============================================================================

	openMagicLinkModal(): void {
		new MagicLinkModal(this).open();
	}

	// ============================================================================
	// Sync Operations
	// ============================================================================

	/**
	 * Start the sync process
	 */
	async startSync(): Promise<void> {
		if (!this.authManager.isAuthenticated()) {
			this.notificationManager.warning('Please log in to start syncing');
			return;
		}

		if (!this.settings.syncEnabled) {
			return;
		}

		this.setConnectionStatus('connecting');

		try {
			// TODO: Initialize WebSocket connection
			// TODO: Initialize file watcher
			// TODO: Perform initial sync

			this.setConnectionStatus('connected');
			this.setSyncStatus('idle');
			this.notificationManager.success('Sync started');
		} catch (error) {
			console.error('Failed to start sync:', error);
			this.setConnectionStatus('error');
			this.notificationManager.error('Failed to start sync');
		}
	}

	/**
	 * Stop the sync process
	 */
	async stopSync(): Promise<void> {
		// TODO: Close WebSocket connection
		// TODO: Stop file watcher
		// TODO: Flush pending changes

		this.setConnectionStatus('disconnected');
		this.setSyncStatus('idle');
	}

	/**
	 * Trigger a manual full sync
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.authManager.isAuthenticated()) {
			this.notificationManager.warning('Please log in to sync');
			return;
		}

		this.setSyncStatus('syncing');
		this.statusBar?.showSyncing();

		try {
			// TODO: Perform full sync
			// - List all remote files
			// - Compare with local files
			// - Upload/download as needed

			this.setSyncStatus('idle');
			this.notificationManager.success('Sync completed');
		} catch (error) {
			console.error('Manual sync failed:', error);
			this.setSyncStatus('error');
			this.notificationManager.error('Sync failed');
		}
	}

	// ============================================================================
	// Commands
	// ============================================================================

	private registerCommands(): void {
		// Login command
		this.addCommand({
			id: 'login',
			name: 'Login with email',
			callback: () => {
				if (this.authManager.isAuthenticated()) {
					this.notificationManager.info(`Already logged in as ${this.settings.userEmail}`);
				} else {
					this.openMagicLinkModal();
				}
			},
		});

		// Logout command
		this.addCommand({
			id: 'logout',
			name: 'Logout',
			checkCallback: (checking) => {
				if (!this.authManager.isAuthenticated()) {
					return false;
				}
				if (!checking) {
					this.authManager.logout();
				}
				return true;
			},
		});

		// Manual sync command
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			checkCallback: (checking) => {
				if (!this.authManager.isAuthenticated() || !this.settings.syncEnabled) {
					return false;
				}
				if (!checking) {
					this.triggerManualSync();
				}
				return true;
			},
		});

		// Toggle sync command
		this.addCommand({
			id: 'toggle-sync',
			name: 'Toggle sync',
			checkCallback: (checking) => {
				if (!this.authManager.isAuthenticated()) {
					return false;
				}
				if (!checking) {
					this.settings.syncEnabled = !this.settings.syncEnabled;
					this.saveSettings();

					if (this.settings.syncEnabled) {
						this.startSync();
						this.notificationManager.info('Sync enabled');
					} else {
						this.stopSync();
						this.notificationManager.info('Sync disabled');
					}
				}
				return true;
			},
		});
	}
}
