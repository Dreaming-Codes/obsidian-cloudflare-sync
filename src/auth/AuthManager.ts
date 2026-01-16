import { Notice, requestUrl } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { AuthState, JWTPayload, MagicLinkResponse, RefreshResponse, VerifyResponse } from '../types';

/**
 * Manages authentication state, JWT tokens, and auth operations
 */
export class AuthManager {
	private plugin: CloudflareSyncPlugin;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	/** Buffer time before token expiry to trigger refresh (5 minutes) */
	private static readonly REFRESH_BUFFER_MS = 5 * 60 * 1000;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Initialize the auth manager - call on plugin load
	 */
	async initialize(): Promise<void> {
		// Check if we have a valid token and schedule refresh
		if (this.isAuthenticated()) {
			this.scheduleTokenRefresh();
		}
	}

	/**
	 * Clean up - call on plugin unload
	 */
	cleanup(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/**
	 * Get the current authentication state
	 */
	getAuthState(): AuthState {
		return {
			isAuthenticated: this.isAuthenticated(),
			userEmail: this.plugin.settings.userEmail,
			userId: this.plugin.settings.userId,
		};
	}

	/**
	 * Check if user is currently authenticated with a valid token
	 */
	isAuthenticated(): boolean {
		const { authToken, tokenExpiry } = this.plugin.settings;

		if (!authToken || !tokenExpiry) {
			return false;
		}

		// Check if token is expired (with 1 minute buffer)
		const now = Math.floor(Date.now() / 1000);
		return tokenExpiry > now + 60;
	}

	/**
	 * Get the current JWT token if valid
	 */
	getToken(): string | null {
		if (!this.isAuthenticated()) {
			return null;
		}
		return this.plugin.settings.authToken;
	}

	/**
	 * Get authorization header for API requests
	 */
	getAuthHeader(): Record<string, string> {
		const token = this.getToken();
		if (!token) {
			return {};
		}
		return { Authorization: `Bearer ${token}` };
	}

	/**
	 * Get a valid JWT token, refreshing if necessary.
	 * Returns null if not authenticated or refresh fails.
	 */
	async getValidToken(): Promise<string | null> {
		const { authToken, tokenExpiry } = this.plugin.settings;

		if (!authToken) {
			return null;
		}

		// Check if token is still valid (with 1 minute buffer)
		const now = Math.floor(Date.now() / 1000);
		if (tokenExpiry && tokenExpiry > now + 60) {
			return authToken;
		}

		// Token is expired or about to expire, try to refresh
		const refreshed = await this.refreshToken();
		if (refreshed) {
			return this.plugin.settings.authToken;
		}

		// Refresh failed
		return null;
	}

	/**
	 * Request a magic link to be sent to the email
	 */
	async requestMagicLink(email: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.plugin.settings.serverUrl}/auth/magic-link`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email }),
			});

			const data = response.json as MagicLinkResponse;

			if (data.success) {
				new Notice('Magic link sent! Check your email.');
				return true;
			}

			new Notice(`Failed to send magic link: ${data.message}`);
			return false;
		} catch (error) {
			console.error('Failed to request magic link:', error);
			new Notice('Failed to send magic link. Please try again.');
			return false;
		}
	}

	/**
	 * Verify a magic link token and complete login
	 */
	async verifyToken(token: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.plugin.settings.serverUrl}/auth/verify?token=${encodeURIComponent(token)}`,
				method: 'GET',
			});

			const data = response.json as VerifyResponse;

			if (data.success && data.token && data.user) {
				await this.handleSuccessfulAuth(data.token, data.user.email, data.user.id);
				new Notice(`Logged in as ${data.user.email}`);
				return true;
			}

			new Notice('Invalid or expired magic link');
			return false;
		} catch (error) {
			console.error('Failed to verify token:', error);
			new Notice('Failed to verify magic link. Please try again.');
			return false;
		}
	}

	/**
	 * Refresh the current JWT token
	 */
	async refreshToken(): Promise<boolean> {
		const currentToken = this.plugin.settings.authToken;
		if (!currentToken) {
			return false;
		}

		try {
			const response = await requestUrl({
				url: `${this.plugin.settings.serverUrl}/auth/refresh`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${currentToken}`,
				},
			});

			const data = response.json as RefreshResponse;

			if (data.success && data.token) {
				const payload = this.decodeToken(data.token);
				if (payload) {
					this.plugin.settings.authToken = data.token;
					this.plugin.settings.tokenExpiry = payload.exp;
					await this.plugin.saveSettings();
					this.scheduleTokenRefresh();
					return true;
				}
			}

			return false;
		} catch (error) {
			console.error('Failed to refresh token:', error);
			// Token refresh failed - user may need to re-authenticate
			return false;
		}
	}

	/**
	 * Logout from the current session
	 */
	async logout(): Promise<void> {
		const token = this.plugin.settings.authToken;

		// Clear local auth state first
		await this.clearAuthState();

		// Try to invalidate on server (best effort)
		if (token) {
			try {
				await requestUrl({
					url: `${this.plugin.settings.serverUrl}/auth/logout`,
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				});
			} catch {
				// Ignore server errors during logout
			}
		}

		new Notice('Logged out');
	}

	/**
	 * Logout from all devices
	 */
	async logoutAll(): Promise<void> {
		const token = this.plugin.settings.authToken;

		// Clear local auth state first
		await this.clearAuthState();

		// Invalidate all sessions on server
		if (token) {
			try {
				await requestUrl({
					url: `${this.plugin.settings.serverUrl}/auth/sessions`,
					method: 'DELETE',
					headers: { Authorization: `Bearer ${token}` },
				});
				new Notice('Logged out from all devices');
			} catch {
				new Notice('Logged out locally, but failed to logout from other devices');
			}
		} else {
			new Notice('Logged out');
		}
	}

	/**
	 * Handle successful authentication
	 */
	private async handleSuccessfulAuth(token: string, email: string, userId: string): Promise<void> {
		const payload = this.decodeToken(token);

		this.plugin.settings.authToken = token;
		this.plugin.settings.userEmail = email;
		this.plugin.settings.userId = userId;
		this.plugin.settings.tokenExpiry = payload?.exp ?? null;

		await this.plugin.saveSettings();
		this.scheduleTokenRefresh();
	}

	/**
	 * Clear all authentication state
	 */
	private async clearAuthState(): Promise<void> {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}

		this.plugin.settings.authToken = null;
		this.plugin.settings.userEmail = null;
		this.plugin.settings.userId = null;
		this.plugin.settings.tokenExpiry = null;
		this.plugin.settings.refreshToken = null;

		await this.plugin.saveSettings();
	}

	/**
	 * Schedule a token refresh before expiry
	 */
	private scheduleTokenRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}

		const { tokenExpiry } = this.plugin.settings;
		if (!tokenExpiry) {
			return;
		}

		const now = Date.now();
		const expiryMs = tokenExpiry * 1000;
		const refreshTime = expiryMs - AuthManager.REFRESH_BUFFER_MS;

		if (refreshTime <= now) {
			// Token is about to expire, refresh now
			this.refreshToken();
		} else {
			// Schedule refresh
			const delay = refreshTime - now;
			this.refreshTimer = setTimeout(() => {
				this.refreshToken();
			}, delay);
		}
	}

	/**
	 * Decode a JWT token without verification (client-side only)
	 */
	private decodeToken(token: string): JWTPayload | null {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) {
				return null;
			}

			const payloadPart = parts[1]!;
			// Base64url decode
			const decoded = atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'));
			return JSON.parse(decoded) as JWTPayload;
		} catch {
			return null;
		}
	}
}
