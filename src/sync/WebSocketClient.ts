/**
 * WebSocket client for real-time sync notifications.
 * Connects to the server and receives notifications when files change on other devices.
 */

import type CloudflareSyncPlugin from '../main';
import type { ServerMessage, ClientMessage } from '../types';

export type WebSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface WebSocketClientOptions {
	/** Maximum number of reconnection attempts before giving up */
	maxReconnectAttempts?: number;
	/** Initial reconnect delay in ms */
	initialReconnectDelay?: number;
	/** Maximum reconnect delay in ms */
	maxReconnectDelay?: number;
}

const DEFAULT_OPTIONS: Required<WebSocketClientOptions> = {
	maxReconnectAttempts: 10,
	initialReconnectDelay: 1000,
	maxReconnectDelay: 60000,
};

/**
 * WebSocket client for receiving real-time sync notifications from the server.
 */
export class WebSocketClient {
	private plugin: CloudflareSyncPlugin;
	private options: Required<WebSocketClientOptions>;
	private ws: WebSocket | null = null;
	private status: WebSocketStatus = 'disconnected';
	private reconnectAttempts: number = 0;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private pingInterval: ReturnType<typeof setInterval> | null = null;
	private lastPongTime: number = 0;

	/** Callback for when a sync message is received */
	private onSyncCallback: ((path: string, action: 'upload' | 'delete', originDevice: string, contentHash?: string) => void) | null = null;
	/** Callback for when connection status changes */
	private onStatusChangeCallback: ((status: WebSocketStatus) => void) | null = null;

	constructor(plugin: CloudflareSyncPlugin, options?: WebSocketClientOptions) {
		this.plugin = plugin;
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Connect to the WebSocket server.
	 */
	async connect(): Promise<void> {
		if (this.ws && (this.status === 'connected' || this.status === 'connecting')) {
			console.log('[WebSocketClient] Already connected or connecting');
			return;
		}

		const token = await this.plugin.authManager.getValidToken();
		if (!token) {
			console.log('[WebSocketClient] No valid token, cannot connect');
			return;
		}

		this.setStatus('connecting');

		try {
			// Build WebSocket URL
			const serverUrl = this.plugin.settings.serverUrl;
			const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);

			console.log('[WebSocketClient] Connecting to WebSocket...');
			this.ws = new WebSocket(wsUrl);

			this.ws.onopen = () => {
				console.log('[WebSocketClient] Connected');
				this.reconnectAttempts = 0;
				this.setStatus('connected');
				this.startPingInterval();
			};

			this.ws.onmessage = (event) => {
				this.handleMessage(event.data);
			};

			this.ws.onerror = (error) => {
				console.error('[WebSocketClient] WebSocket error:', error);
			};

			this.ws.onclose = (event) => {
				console.log(`[WebSocketClient] Connection closed: ${event.code} ${event.reason}`);
				this.stopPingInterval();
				this.ws = null;

				// Attempt to reconnect if not intentionally disconnected
				if (this.status !== 'disconnected') {
					this.scheduleReconnect();
				}
			};
		} catch (error) {
			console.error('[WebSocketClient] Failed to connect:', error);
			this.setStatus('disconnected');
			this.scheduleReconnect();
		}
	}

	/**
	 * Disconnect from the WebSocket server.
	 */
	disconnect(): void {
		console.log('[WebSocketClient] Disconnecting...');
		this.setStatus('disconnected');

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		this.stopPingInterval();

		if (this.ws) {
			this.ws.close(1000, 'Client disconnecting');
			this.ws = null;
		}

		this.reconnectAttempts = 0;
	}

	/**
	 * Get the current connection status.
	 */
	getStatus(): WebSocketStatus {
		return this.status;
	}

	/**
	 * Set callback for sync notifications.
	 */
	onSync(callback: (path: string, action: 'upload' | 'delete', originDevice: string, contentHash?: string) => void): void {
		this.onSyncCallback = callback;
	}

	/**
	 * Set callback for status changes.
	 */
	onStatusChange(callback: (status: WebSocketStatus) => void): void {
		this.onStatusChangeCallback = callback;
	}

	/**
	 * Handle incoming WebSocket messages.
	 */
	private handleMessage(data: string): void {
		try {
			const message = JSON.parse(data) as ServerMessage;

			switch (message.type) {
				case 'sync':
					console.log(`[WebSocketClient] Sync notification: ${message.action} ${message.path}`);
					this.onSyncCallback?.(message.path, message.action, message.originDevice, message.contentHash);
					break;

				case 'connected':
					console.log(`[WebSocketClient] Server confirmed connection for device: ${message.deviceId}`);
					break;

				case 'ping':
					// Respond with pong
					this.send({ type: 'pong' });
					this.lastPongTime = Date.now();
					break;

				case 'error':
					console.error(`[WebSocketClient] Server error: ${message.message}`);
					break;

				default:
					console.warn('[WebSocketClient] Unknown message type:', message);
			}
		} catch (error) {
			console.error('[WebSocketClient] Failed to parse message:', error, data);
		}
	}

	/**
	 * Send a message to the server.
	 */
	private send(message: ClientMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	/**
	 * Set the connection status and notify callback.
	 */
	private setStatus(status: WebSocketStatus): void {
		if (this.status !== status) {
			this.status = status;
			this.onStatusChangeCallback?.(status);
		}
	}

	/**
	 * Schedule a reconnection attempt with exponential backoff.
	 */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
			console.log('[WebSocketClient] Max reconnect attempts reached, giving up');
			this.setStatus('disconnected');
			return;
		}

		this.setStatus('reconnecting');

		// Exponential backoff with jitter
		const baseDelay = Math.min(
			this.options.initialReconnectDelay * Math.pow(2, this.reconnectAttempts),
			this.options.maxReconnectDelay
		);
		const jitter = Math.random() * 0.3 * baseDelay;
		const delay = baseDelay + jitter;

		console.log(`[WebSocketClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts + 1}/${this.options.maxReconnectAttempts})`);

		this.reconnectTimeout = setTimeout(() => {
			this.reconnectAttempts++;
			this.connect();
		}, delay);
	}

	/**
	 * Start the ping interval to keep the connection alive.
	 */
	private startPingInterval(): void {
		// Server sends pings, we just track that we're receiving them
		// If we don't receive a ping for 60 seconds, reconnect
		this.lastPongTime = Date.now();

		this.pingInterval = setInterval(() => {
			const timeSinceLastPong = Date.now() - this.lastPongTime;
			if (timeSinceLastPong > 60000) {
				console.log('[WebSocketClient] No ping received for 60s, reconnecting...');
				this.ws?.close(4000, 'Ping timeout');
			}
		}, 30000);
	}

	/**
	 * Stop the ping interval.
	 */
	private stopPingInterval(): void {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
	}
}
