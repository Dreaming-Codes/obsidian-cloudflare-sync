import { App, PluginSettingTab } from 'obsidian';
import { createElement, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type CloudflareSyncPlugin from './main';
import { PluginContext } from './ui/context/PluginContext';
import { SettingsView } from './ui/components/SettingsView';

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
	/** Unique device identifier for multi-device sync */
	deviceId: string | null;
	/** Device name for display purposes */
	deviceName: string | null;
	/** Map of file path to last-synced content hash (base for conflict detection) */
	fileBaseHashes: Record<string, string>;
}

export const DEFAULT_SETTINGS: CloudflareSyncSettings = {
	serverUrl: 'https://sync.elysiumcraftrp.org',
	userEmail: null,
	userId: null,
	syncEnabled: true,
	authToken: null,
	tokenExpiry: null,
	refreshToken: null,
	deviceId: null,
	deviceName: null,
	fileBaseHashes: {},
};

// ============================================================================
// Settings Tab (React-based)
// ============================================================================

export class CloudflareSyncSettingTab extends PluginSettingTab {
	plugin: CloudflareSyncPlugin;
	private root: Root | null = null;

	constructor(app: App, plugin: CloudflareSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Create React root and render settings using createElement (no JSX in .ts file)
		this.root = createRoot(containerEl);
		this.root.render(
			createElement(
				StrictMode,
				null,
				createElement(
					PluginContext.Provider,
					{ value: { app: this.app, plugin: this.plugin } },
					createElement(SettingsView)
				)
			)
		);
	}

	hide(): void {
		// Cleanup React root when tab is hidden
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
	}
}
