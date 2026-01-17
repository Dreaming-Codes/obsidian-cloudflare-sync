import { useState, useEffect, useCallback } from 'react';
import { usePlugin } from '../hooks/usePlugin';
import type { ConnectionStatus, SyncProgress, SyncStatus } from '../../types';

interface SettingsState {
	serverUrl: string;
	syncEnabled: boolean;
	isLoggedIn: boolean;
	userEmail: string | null;
	connectionStatus: ConnectionStatus;
	syncStatus: SyncStatus;
	syncProgress: SyncProgress;
}

const DEFAULT_PROGRESS: SyncProgress = {
	isActive: false,
	phase: 'idle',
	totalFiles: 0,
	processedFiles: 0,
	currentFile: null,
	percentage: 0,
};

export function SettingsView() {
	const { plugin } = usePlugin();

	const [state, setState] = useState<SettingsState>(() => ({
		serverUrl: plugin.settings.serverUrl,
		syncEnabled: plugin.settings.syncEnabled,
		isLoggedIn: !!plugin.settings.authToken,
		userEmail: plugin.settings.userEmail,
		connectionStatus: plugin.getConnectionStatus(),
		syncStatus: plugin.getSyncStatus(),
		syncProgress: plugin.getSyncManager()?.getProgress() ?? DEFAULT_PROGRESS,
	}));

	// Refresh state when settings change
	const refreshState = useCallback(() => {
		setState((prev) => ({
			...prev,
			serverUrl: plugin.settings.serverUrl,
			syncEnabled: plugin.settings.syncEnabled,
			isLoggedIn: !!plugin.settings.authToken,
			userEmail: plugin.settings.userEmail,
			connectionStatus: plugin.getConnectionStatus(),
			syncStatus: plugin.getSyncStatus(),
		}));
	}, [plugin]);

	// Subscribe to sync progress updates
	useEffect(() => {
		const syncManager = plugin.getSyncManager();
		if (!syncManager) {
			return;
		}

		const unsubscribe = syncManager.onProgress((progress) => {
			setState((prev) => ({ ...prev, syncProgress: progress }));
		});

		return () => unsubscribe();
	}, [plugin, state.isLoggedIn, state.syncEnabled]);

	useEffect(() => {
		// Poll for status updates
		const interval = setInterval(refreshState, 1000);
		return () => clearInterval(interval);
	}, [refreshState]);

	const handleServerUrlChange = async (value: string) => {
		try {
			new URL(value);
			plugin.settings.serverUrl = value.replace(/\/$/, '');
			await plugin.saveSettings();
			setState((s) => ({ ...s, serverUrl: value }));
		} catch {
			// Invalid URL, don't save
		}
	};

	const handleSyncToggle = async () => {
		const newValue = !state.syncEnabled;
		plugin.settings.syncEnabled = newValue;
		await plugin.saveSettings();

		if (newValue) {
			await plugin.startSync();
		} else {
			await plugin.stopSync();
		}

		setState((s) => ({ ...s, syncEnabled: newValue }));
	};

	const handleLogout = async () => {
		await plugin.authManager.logout();
		refreshState();
	};

	const handleLogoutAll = async () => {
		await plugin.authManager.logoutAll();
		refreshState();
	};

	const handleManualSync = async () => {
		await plugin.triggerManualSync();
	};

	const handleForceReupload = async () => {
		const confirmed = confirm(
			'This will clear all remote file metadata and re-upload all local files. ' +
				'This operation may take a while for large vaults.\n\n' +
				'Are you sure you want to continue?'
		);
		if (confirmed) {
			await plugin.triggerForceReupload();
		}
	};

	const handleLogin = () => {
		plugin.openMagicLinkModal();
	};

	return (
		<div className="cloudflare-sync-settings">
			<h2>Cloudflare Sync</h2>

			<StatusIndicator
				connectionStatus={state.connectionStatus}
				syncStatus={state.syncStatus}
				isLoggedIn={state.isLoggedIn}
			/>

			{/* Show progress bar when syncing */}
			{state.syncProgress.isActive && (
				<SyncProgressBar progress={state.syncProgress} />
			)}

			<h3>Server</h3>
			<SettingItem
				name="Server URL"
				description="The URL of your Cloudflare Sync backend"
			>
				<input
					type="text"
					placeholder="https://sync.example.com"
					value={state.serverUrl}
					onChange={(e) => handleServerUrlChange(e.target.value)}
				/>
			</SettingItem>

			<h3>Authentication</h3>
			{state.isLoggedIn ? (
				<>
					<SettingItem
						name="Logged in as"
						description={state.userEmail ?? 'Unknown'}
					>
						<button className="mod-warning" onClick={handleLogout}>
							Logout
						</button>
					</SettingItem>
					<SettingItem name="Security">
						<button className="mod-warning" onClick={handleLogoutAll}>
							Logout from all devices
						</button>
					</SettingItem>
				</>
			) : (
				<SettingItem
					name="Login"
					description="Sign in with your email to start syncing"
				>
					<button onClick={handleLogin}>Login with email</button>
				</SettingItem>
			)}

			<h3>Sync</h3>
			<SettingItem
				name="Enable sync"
				description="Automatically sync changes with the server"
			>
				<div
					className={`checkbox-container ${state.syncEnabled ? 'is-enabled' : ''}`}
					onClick={state.isLoggedIn ? handleSyncToggle : undefined}
					style={{ opacity: state.isLoggedIn ? 1 : 0.5 }}
				>
					<input
						type="checkbox"
						checked={state.syncEnabled}
						disabled={!state.isLoggedIn}
						readOnly
					/>
				</div>
			</SettingItem>

			{state.isLoggedIn && (
				<>
					<SettingItem
						name="Manual sync"
						description="Trigger a full sync now"
					>
						<button
							onClick={handleManualSync}
							disabled={!state.syncEnabled || state.syncProgress.isActive}
						>
							{state.syncProgress.isActive ? 'Syncing...' : 'Sync now'}
						</button>
					</SettingItem>
					<SettingItem
						name="Force re-upload all"
						description="Clear remote data and re-upload all local files. Use this to fix sync issues."
					>
						<button
							className="mod-warning"
							onClick={handleForceReupload}
							disabled={!state.syncEnabled || state.syncProgress.isActive}
						>
							Re-upload all
						</button>
					</SettingItem>
				</>
			)}
		</div>
	);
}

// ============================================================================
// Sub-components
// ============================================================================

interface SettingItemProps {
	name: string;
	description?: string;
	children: React.ReactNode;
}

function SettingItem({ name, description, children }: SettingItemProps) {
	return (
		<div className="setting-item">
			<div className="setting-item-info">
				<div className="setting-item-name">{name}</div>
				{description && (
					<div className="setting-item-description">{description}</div>
				)}
			</div>
			<div className="setting-item-control">{children}</div>
		</div>
	);
}

interface StatusIndicatorProps {
	connectionStatus: ConnectionStatus;
	syncStatus: SyncStatus;
	isLoggedIn: boolean;
}

function StatusIndicator({
	connectionStatus,
	syncStatus,
	isLoggedIn,
}: StatusIndicatorProps) {
	const getStatusText = (): string => {
		if (!isLoggedIn) return 'Not logged in';

		switch (connectionStatus) {
			case 'connected':
				switch (syncStatus) {
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
	};

	const getStatusClass = (): string => {
		switch (connectionStatus) {
			case 'connected':
				return 'status-connected';
			case 'connecting':
				return 'status-connecting';
			case 'error':
				return 'status-error';
			default:
				return 'status-disconnected';
		}
	};

	return (
		<div className="cloudflare-sync-status">
			<div className={`status-indicator ${getStatusClass()}`}>
				<span>{getStatusText()}</span>
			</div>
		</div>
	);
}

interface SyncProgressBarProps {
	progress: SyncProgress;
}

function SyncProgressBar({ progress }: SyncProgressBarProps) {
	const getPhaseText = (): string => {
		switch (progress.phase) {
			case 'listing':
				return 'Scanning files...';
			case 'uploading':
				return 'Uploading';
			case 'downloading':
				return 'Downloading';
			case 'complete':
				return 'Complete';
			default:
				return 'Syncing';
		}
	};

	const truncateFilename = (path: string | null, maxLength: number = 40): string => {
		if (!path) return '';
		if (path.length <= maxLength) return path;
		return '...' + path.slice(-maxLength + 3);
	};

	return (
		<div className="cloudflare-sync-progress">
			<div className="sync-progress-header">
				<span className="sync-progress-phase">{getPhaseText()}</span>
				<span className="sync-progress-count">
					{progress.processedFiles} / {progress.totalFiles} files
				</span>
			</div>
			<div className="sync-progress-bar-container">
				<div
					className="sync-progress-bar-fill"
					style={{ width: `${progress.percentage}%` }}
				/>
			</div>
			{progress.currentFile && (
				<div className="sync-progress-current-file">
					{truncateFilename(progress.currentFile)}
				</div>
			)}
		</div>
	);
}
