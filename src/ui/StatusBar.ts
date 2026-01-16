import type CloudflareSyncPlugin from '../main';
import type { ConnectionStatus, SyncStatus } from '../types';

/**
 * Status bar component showing sync status
 */
export class StatusBar {
	private plugin: CloudflareSyncPlugin;
	private statusBarEl: HTMLElement | null = null;
	private iconEl: HTMLElement | null = null;
	private textEl: HTMLElement | null = null;
	private pendingEl: HTMLElement | null = null;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Initialize the status bar - call on plugin load
	 */
	initialize(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClass('cloudflare-sync-statusbar');

		// Create icon element
		this.iconEl = this.statusBarEl.createSpan({ cls: 'cloudflare-sync-statusbar-icon' });

		// Create text element
		this.textEl = this.statusBarEl.createSpan({ cls: 'cloudflare-sync-statusbar-text' });

		// Create pending count element (hidden by default)
		this.pendingEl = this.statusBarEl.createSpan({ cls: 'cloudflare-sync-statusbar-pending' });

		// Add click handler to open settings
		this.statusBarEl.addEventListener('click', () => {
			// Open plugin settings
			const app = this.plugin.app as { setting?: { open: () => void; openTabById: (id: string) => void } };
			app.setting?.open();
			app.setting?.openTabById('cloudflare-sync');
		});

		// Initial render
		this.update();
	}

	/**
	 * Update the status bar display
	 */
	update(): void {
		if (!this.statusBarEl || !this.iconEl || !this.textEl || !this.pendingEl) {
			return;
		}

		const connectionStatus = this.plugin.getConnectionStatus();
		const syncStatus = this.plugin.getSyncStatus();
		const isAuthenticated = this.plugin.authManager?.isAuthenticated() ?? false;

		// Get pending count from offline queue
		const pendingCount = this.getPendingCount();

		// Update icon
		this.iconEl.empty();
		this.iconEl.textContent = this.getIcon(connectionStatus, syncStatus, isAuthenticated);

		// Update text
		this.textEl.textContent = this.getText(connectionStatus, syncStatus, isAuthenticated);

		// Update pending count badge
		if (syncStatus === 'offline' && pendingCount > 0) {
			this.pendingEl.textContent = `(${pendingCount})`;
			this.pendingEl.removeClass('hidden');
		} else {
			this.pendingEl.textContent = '';
			this.pendingEl.addClass('hidden');
		}

		// Update classes for styling
		this.statusBarEl.removeClass(
			'status-connected',
			'status-connecting',
			'status-disconnected',
			'status-error',
			'status-syncing',
			'status-offline',
		);
		this.statusBarEl.addClass(this.getStatusClass(connectionStatus, syncStatus, isAuthenticated));

		// Update tooltip
		this.statusBarEl.setAttribute('aria-label', this.getTooltip(connectionStatus, syncStatus, isAuthenticated, pendingCount));
	}

	/**
	 * Get the number of pending operations from the offline queue
	 */
	private getPendingCount(): number {
		const syncManager = this.plugin.getSyncManager();
		if (!syncManager) {
			return 0;
		}
		return syncManager.getOfflineQueue().getPendingCount();
	}

	/**
	 * Get icon for current status
	 */
	private getIcon(connection: ConnectionStatus, sync: SyncStatus, isAuthenticated: boolean): string {
		if (!isAuthenticated) {
			return '🔒'; // Locked - not logged in
		}

		switch (connection) {
			case 'connected':
				switch (sync) {
					case 'syncing':
						return '🔄'; // Syncing
					case 'error':
						return '⚠️'; // Sync error
					case 'offline':
						return '📴'; // Offline
					default:
						return '☁️'; // Connected/idle
				}
			case 'connecting':
				return '🔗'; // Connecting
			case 'error':
				return '❌'; // Connection error
			default:
				return '☁️'; // Disconnected
		}
	}

	/**
	 * Get text for current status
	 */
	private getText(connection: ConnectionStatus, sync: SyncStatus, isAuthenticated: boolean): string {
		if (!isAuthenticated) {
			return 'Not syncing';
		}

		if (!this.plugin.settings.syncEnabled) {
			return 'Sync disabled';
		}

		switch (connection) {
			case 'connected':
				switch (sync) {
					case 'syncing':
						return 'Syncing...';
					case 'error':
						return 'Sync error';
					case 'offline':
						return 'Offline';
					default:
						return 'Synced';
				}
			case 'connecting':
				return 'Connecting...';
			case 'error':
				return 'Connection error';
			default:
				return 'Disconnected';
		}
	}

	/**
	 * Get CSS class for current status
	 */
	private getStatusClass(connection: ConnectionStatus, sync: SyncStatus, isAuthenticated: boolean): string {
		if (!isAuthenticated) {
			return 'status-disconnected';
		}

		switch (connection) {
			case 'connected':
				switch (sync) {
					case 'syncing':
						return 'status-syncing';
					case 'error':
						return 'status-error';
					case 'offline':
						return 'status-offline';
					default:
						return 'status-connected';
				}
			case 'connecting':
				return 'status-connecting';
			case 'error':
				return 'status-error';
			default:
				return 'status-disconnected';
		}
	}

	/**
	 * Get tooltip for current status
	 */
	private getTooltip(connection: ConnectionStatus, sync: SyncStatus, isAuthenticated: boolean, pendingCount: number = 0): string {
		if (!isAuthenticated) {
			return 'Cloudflare Sync: Not logged in. Click to configure.';
		}

		if (!this.plugin.settings.syncEnabled) {
			return 'Cloudflare Sync: Sync is disabled. Click to configure.';
		}

		const user = this.plugin.settings.userEmail ?? 'Unknown';

		switch (connection) {
			case 'connected':
				switch (sync) {
					case 'syncing':
						return `Cloudflare Sync: Syncing as ${user}`;
					case 'error':
						return `Cloudflare Sync: Sync error. Click for details.`;
					case 'offline':
						const pendingMsg = pendingCount > 0 ? ` (${pendingCount} pending)` : '';
						return `Cloudflare Sync: Offline${pendingMsg} - changes will sync when reconnected`;
					default:
						return `Cloudflare Sync: Connected as ${user}`;
				}
			case 'connecting':
				return `Cloudflare Sync: Connecting as ${user}...`;
			case 'error':
				return 'Cloudflare Sync: Connection error. Click for details.';
			default:
				return 'Cloudflare Sync: Disconnected. Click to configure.';
		}
	}

	/**
	 * Show a temporary syncing animation
	 */
	showSyncing(): void {
		this.update();
	}

	/**
	 * Clean up - call on plugin unload
	 */
	cleanup(): void {
		// Status bar is automatically cleaned up by Obsidian
		this.statusBarEl = null;
		this.iconEl = null;
		this.textEl = null;
		this.pendingEl = null;
	}
}
