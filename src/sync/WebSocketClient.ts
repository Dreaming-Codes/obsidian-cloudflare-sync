/**
 * WebSocket Client for real-time sync with the Cloudflare worker.
 * Handles connection, reconnection, and message routing.
 * 
 * Each WebSocket connection is tied to a specific document (doc_id).
 * When switching documents, the client disconnects and reconnects.
 */

import { ClientMessage, ServerMessage, ConnectionStatus } from '../types';

export interface WebSocketClientConfig {
	serverUrl: string;
	getToken: () => Promise<string | null>;
	onMessage: (message: ServerMessage) => void;
	onStatusChange: (status: ConnectionStatus) => void;
	reconnectDelay?: number;
	maxReconnectDelay?: number;
	pingInterval?: number;
}

export class WebSocketClient {
	private ws: WebSocket | null = null;
	private config: Required<WebSocketClientConfig>;
	private status: ConnectionStatus = 'disconnected';
	private reconnectAttempts = 0;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private pingTimeout: ReturnType<typeof setInterval> | null = null;
	private currentDocId: string | null = null;
	private pendingMessages: ClientMessage[] = [];
	private destroyed = false;

	constructor(config: WebSocketClientConfig) {
		this.config = {
			reconnectDelay: 1000,
			maxReconnectDelay: 30000,
			pingInterval: 30000,
			...config,
		};
	}

	/**
	 * Connect to the WebSocket server for a specific document.
	 * If already connected to a different document, will disconnect first.
	 */
	async connect(docId: string): Promise<void> {
		if (this.destroyed) return;

		// If already connected to this document, do nothing
		if (this.currentDocId === docId && this.ws?.readyState === WebSocket.OPEN) {
			return;
		}

		// Disconnect from current document if different
		if (this.currentDocId && this.currentDocId !== docId) {
			this.disconnectInternal();
		}

		this.currentDocId = docId;
		this.setStatus('connecting');

		const token = await this.config.getToken();
		if (!token) {
			this.setStatus('error');
			console.error('[WebSocketClient] No auth token available');
			return;
		}

		// Build WebSocket URL with doc_id
		const wsUrl = this.config.serverUrl
			.replace(/^https?:\/\//, 'wss://')
			.replace(/\/$/, '');

		try {
			const url = `${wsUrl}/ws?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(docId)}`;
			console.log('[WebSocketClient] Connecting to:', url.replace(/token=[^&]+/, 'token=***'));
			this.ws = new WebSocket(url);
			this.setupEventHandlers();
		} catch (error) {
			console.error('[WebSocketClient] Failed to create WebSocket:', error);
			this.setStatus('error');
			this.scheduleReconnect();
		}
	}

	/**
	 * Disconnect from the WebSocket server.
	 */
	disconnect(): void {
		this.currentDocId = null;
		this.disconnectInternal();
	}

	/**
	 * Internal disconnect without clearing currentDocId (for reconnection).
	 */
	private disconnectInternal(): void {
		this.clearTimers();

		if (this.ws) {
			this.ws.onclose = null; // Prevent reconnect on intentional close
			this.ws.close(1000, 'Client disconnecting');
			this.ws = null;
		}

		this.setStatus('disconnected');
	}

	/**
	 * Destroy the client and clean up resources.
	 */
	destroy(): void {
		this.destroyed = true;
		this.disconnect();
	}

	/**
	 * Send a message to the server.
	 */
	send(message: ClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		} else {
			// Queue message for when connected
			this.pendingMessages.push(message);
		}
	}

	/**
	 * Subscribe to the current document for real-time updates.
	 * Note: The connection is already to a specific document, so this
	 * just sends the subscribe message to the DocumentDO.
	 */
	subscribe(docId: string): void {
		if (docId !== this.currentDocId) {
			console.warn('[WebSocketClient] subscribe called with different docId than connected');
		}
		this.send({ type: 'subscribe', doc_id: docId });
	}

	/**
	 * Unsubscribe from a document.
	 */
	unsubscribe(docId: string): void {
		this.send({ type: 'unsubscribe', doc_id: docId });
	}

	/**
	 * Send CRDT sync step 1 (our state vector).
	 */
	sendSyncStep1(docId: string, stateVector: Uint8Array): void {
		this.send({
			type: 'sync_step1',
			doc_id: docId,
			state_vector: this.encodeBase64(stateVector),
		});
	}

	/**
	 * Send CRDT sync step 2 (updates we have).
	 */
	sendSyncStep2(docId: string, update: Uint8Array): void {
		this.send({
			type: 'sync_step2',
			doc_id: docId,
			update: this.encodeBase64(update),
		});
	}

	/**
	 * Send a CRDT update.
	 */
	sendUpdate(docId: string, update: Uint8Array): void {
		this.send({
			type: 'update',
			doc_id: docId,
			update: this.encodeBase64(update),
		});
	}

	/**
	 * Send awareness data (cursor position, etc.).
	 */
	sendAwareness(docId: string, data: Uint8Array): void {
		this.send({
			type: 'awareness',
			doc_id: docId,
			data: this.encodeBase64(data),
		});
	}

	/**
	 * Get the current connection status.
	 */
	getStatus(): ConnectionStatus {
		return this.status;
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * Get the current document ID.
	 */
	getCurrentDocId(): string | null {
		return this.currentDocId;
	}

	// ========== Private Methods ==========

	private setupEventHandlers(): void {
		if (!this.ws) return;

		this.ws.onopen = () => {
			console.log('[WebSocketClient] Connected to doc:', this.currentDocId);
			this.setStatus('connected');
			this.reconnectAttempts = 0;

			// Send pending messages
			while (this.pendingMessages.length > 0) {
				const msg = this.pendingMessages.shift();
				if (msg) this.send(msg);
			}

			// Start ping interval
			this.startPingInterval();
		};

		this.ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data) as ServerMessage;
				this.handleMessage(message);
			} catch (error) {
				console.error('[WebSocketClient] Failed to parse message:', error);
			}
		};

		this.ws.onclose = (event) => {
			console.log('[WebSocketClient] Disconnected:', event.code, event.reason);
			this.ws = null;
			this.clearTimers();

			if (!this.destroyed && this.currentDocId) {
				this.setStatus('disconnected');
				this.scheduleReconnect();
			}
		};

		this.ws.onerror = (error) => {
			console.error('[WebSocketClient] Error:', error);
			this.setStatus('error');
		};
	}

	private handleMessage(message: ServerMessage): void {
		// Handle pong internally
		if (message.type === 'pong') {
			// Could track latency here
			return;
		}

		// Forward to handler
		this.config.onMessage(message);
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status !== status) {
			this.status = status;
			this.config.onStatusChange(status);
		}
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimeout || !this.currentDocId) return;

		const delay = Math.min(
			this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts),
			this.config.maxReconnectDelay
		);

		console.log(`[WebSocketClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.reconnectAttempts++;
			if (this.currentDocId) {
				this.connect(this.currentDocId);
			}
		}, delay);
	}

	private startPingInterval(): void {
		this.clearPingInterval();

		this.pingTimeout = setInterval(() => {
			if (this.isConnected()) {
				this.send({ type: 'ping', timestamp: Date.now() });
			}
		}, this.config.pingInterval);
	}

	private clearPingInterval(): void {
		if (this.pingTimeout) {
			clearInterval(this.pingTimeout);
			this.pingTimeout = null;
		}
	}

	private clearTimers(): void {
		this.clearPingInterval();

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
	}

	private encodeBase64(data: Uint8Array): string {
		// Use browser's built-in btoa for base64 encoding
		let binary = '';
		for (let i = 0; i < data.length; i++) {
			binary += String.fromCharCode(data[i] ?? 0);
		}
		return btoa(binary);
	}
}

/**
 * Decode base64 string to Uint8Array.
 */
export function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
