import { MarkdownView, Plugin, TFile, TFolder, Menu } from 'obsidian';
import { AuthManager } from './auth/AuthManager';
import { MagicLinkModal } from './auth/MagicLinkModal';
import { CloudflareSyncSettingTab, CloudflareSyncSettings, DEFAULT_SETTINGS } from './settings';
import { ShareManager } from './sharing/ShareManager';
import { PendingSharesModal, ShareModal } from './sharing/ShareModal';
import { RealtimeSyncManager } from './sync/RealtimeSyncManager';
import { SyncManager } from './sync/SyncManager';
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
	shareManager!: ShareManager;
	private statusBar!: StatusBar;
	private syncManager: SyncManager | null = null;
	private realtimeSyncManager: RealtimeSyncManager | null = null;

	// Connection and sync state
	private connectionStatus: ConnectionStatus = 'disconnected';
	private syncStatus: SyncStatus = 'idle';

	async onload(): Promise<void> {
		// Load settings
		await this.loadSettings();

		// Initialize managers
		this.authManager = new AuthManager(this);
		this.notificationManager = new NotificationManager(this);
		this.shareManager = new ShareManager(this);
		this.statusBar = new StatusBar(this);

		// Initialize auth (check token validity, schedule refresh)
		await this.authManager.initialize();

		// Initialize status bar
		this.statusBar.initialize();

		// Add settings tab
		this.addSettingTab(new CloudflareSyncSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Register file menu integration
		this.registerFileMenu();

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
		this.stopRealtimeSync();
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

		if (this.syncManager) {
			// Already running
			return;
		}

		this.setConnectionStatus('connecting');

		try {
			// Initialize and start sync manager
			this.syncManager = new SyncManager(this);
			await this.syncManager.start();

			this.setConnectionStatus('connected');
			this.setSyncStatus('idle');
			this.notificationManager.success('Sync started');
		} catch (error) {
			console.error('Failed to start sync:', error);
			this.syncManager = null;
			this.setConnectionStatus('error');
			this.notificationManager.error('Failed to start sync');
		}
	}

	/**
	 * Stop the sync process
	 */
	async stopSync(): Promise<void> {
		if (this.syncManager) {
			await this.syncManager.stop();
			this.syncManager = null;
		}

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

		if (!this.syncManager) {
			// Start sync first if not running
			await this.startSync();
			return;
		}

		this.statusBar?.showSyncing();

		try {
			await this.syncManager.performFullSync();
			this.notificationManager.success('Sync completed');
		} catch (error) {
			console.error('Manual sync failed:', error);
			this.notificationManager.error('Sync failed');
		}
	}

	/**
	 * Get the sync manager instance
	 */
	getSyncManager(): SyncManager | null {
		return this.syncManager;
	}

	// ============================================================================
	// Real-time Sync Operations
	// ============================================================================

	/**
	 * Start real-time collaborative sync
	 */
	async startRealtimeSync(): Promise<void> {
		if (!this.authManager.isAuthenticated()) {
			return;
		}

		if (this.realtimeSyncManager) {
			// Already running
			return;
		}

		try {
			this.realtimeSyncManager = new RealtimeSyncManager({
				app: this.app,
				serverUrl: this.settings.serverUrl,
				getToken: () => this.authManager.getValidToken(),
				onStatusChange: (status) => {
					if (status === 'connected') {
						this.notificationManager.success('Real-time sync connected');
					} else if (status === 'error') {
						this.notificationManager.error('Real-time sync disconnected');
					}
				},
				onCollaboratorJoin: (_docId, _userId, email) => {
					this.notificationManager.info(`${email} joined`);
				},
				onCollaboratorLeave: (_docId, userId) => {
					this.notificationManager.info(`${userId} left`);
				},
			});

			await this.realtimeSyncManager.enable();

			// Register file open handler
			this.registerEvent(
				this.app.workspace.on('file-open', async (file) => {
					if (file && this.realtimeSyncManager) {
						await this.realtimeSyncManager.subscribeToFile(file);
					}
				})
			);

			// Register editor change handler
			this.registerEvent(
				this.app.workspace.on('editor-change', (editor, info) => {
					// The editor-change event doesn't provide change details
					// We'll need to handle this differently in a production app
					// For now, we'll sync the full content periodically
				})
			);

			console.log('[CloudflareSyncPlugin] Real-time sync started');
		} catch (error) {
			console.error('Failed to start real-time sync:', error);
			this.realtimeSyncManager = null;
		}
	}

	/**
	 * Stop real-time collaborative sync
	 */
	stopRealtimeSync(): void {
		if (this.realtimeSyncManager) {
			this.realtimeSyncManager.destroy();
			this.realtimeSyncManager = null;
		}
	}

	/**
	 * Get the real-time sync manager instance
	 */
	getRealtimeSyncManager(): RealtimeSyncManager | null {
		return this.realtimeSyncManager;
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
					this.stopSync();
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

		// Share current file command
		this.addCommand({
			id: 'share-current-file',
			name: 'Share current file',
			checkCallback: (checking) => {
				if (!this.authManager.isAuthenticated()) {
					return false;
				}
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					return false;
				}
				if (!checking) {
					new ShareModal(this, file).open();
				}
				return true;
			},
		});

		// View pending shares command
		this.addCommand({
			id: 'view-pending-shares',
			name: 'View pending share invitations',
			checkCallback: (checking) => {
				if (!this.authManager.isAuthenticated()) {
					return false;
				}
				if (!checking) {
					new PendingSharesModal(this).open();
				}
				return true;
			},
		});
	}

	/**
	 * Register file menu integration for sharing.
	 */
	private registerFileMenu(): void {
		// Add "Share" to file context menu
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!this.authManager.isAuthenticated()) {
					return;
				}

				menu.addItem((item) => {
					item
						.setTitle('Share...')
						.setIcon('share')
						.onClick(() => {
							new ShareModal(this, file).open();
						});
				});
			})
		);
	}
}
