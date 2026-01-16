import { Notice } from 'obsidian';
import type CloudflareSyncPlugin from '../main';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

interface NotificationOptions {
	/** Duration in milliseconds (0 for persistent) */
	duration?: number;
	/** Type of notification for styling */
	type?: NotificationType;
}

/**
 * Manages toast notifications with consistent styling
 */
export class NotificationManager {
	private plugin: CloudflareSyncPlugin;

	/** Default duration for notifications (5 seconds) */
	private static readonly DEFAULT_DURATION = 5000;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Show an info notification
	 */
	info(message: string, options?: Omit<NotificationOptions, 'type'>): void {
		this.show(message, { ...options, type: 'info' });
	}

	/**
	 * Show a success notification
	 */
	success(message: string, options?: Omit<NotificationOptions, 'type'>): void {
		this.show(message, { ...options, type: 'success' });
	}

	/**
	 * Show a warning notification
	 */
	warning(message: string, options?: Omit<NotificationOptions, 'type'>): void {
		this.show(message, { ...options, type: 'warning' });
	}

	/**
	 * Show an error notification
	 */
	error(message: string, options?: Omit<NotificationOptions, 'type'>): void {
		this.show(message, { ...options, type: 'error' });
	}

	/**
	 * Show a notification about sync status
	 */
	syncStatus(message: string): void {
		this.info(`Sync: ${message}`);
	}

	/**
	 * Show an error about sync failure
	 */
	syncError(error: string): void {
		this.error(`Sync error: ${error}`);
	}

	/**
	 * Show a notification about connection status
	 */
	connectionStatus(connected: boolean): void {
		if (connected) {
			this.success('Connected to sync server');
		} else {
			this.warning('Disconnected from sync server');
		}
	}

	/**
	 * Show a notification with custom options
	 */
	private show(message: string, options: NotificationOptions = {}): void {
		const duration = options.duration ?? NotificationManager.DEFAULT_DURATION;
		const type = options.type ?? 'info';

		// Create notice with Obsidian's Notice API
		const notice = new Notice(this.formatMessage(message, type), duration);

		// Add custom class for styling if needed
		const noticeEl = notice.noticeEl;
		noticeEl.addClass(`cloudflare-sync-notice`, `notice-${type}`);
	}

	/**
	 * Format message with optional prefix based on type
	 */
	private formatMessage(message: string, type: NotificationType): string {
		// Obsidian notices are plain text, so we just return the message
		// The emoji prefix helps identify the type visually
		switch (type) {
			case 'success':
				return `✓ ${message}`;
			case 'warning':
				return `⚠ ${message}`;
			case 'error':
				return `✗ ${message}`;
			default:
				return message;
		}
	}
}
