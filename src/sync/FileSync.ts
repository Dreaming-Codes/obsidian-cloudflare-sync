import { requestUrl, TFile } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { FileMeta, FileListResponse, FileVersionsResponse, FileUploadResponse } from '../types';
import { sha256 } from '../utils/hash';

export interface UploadResult {
	success: boolean;
	path: string;
	contentHash?: string;
	error?: string;
	/** Whether a 3-way merge was performed on the server */
	merged?: boolean;
	/** Whether the merge had conflicts (conflict markers inserted) */
	hadConflict?: boolean;
}

export interface DownloadResult {
	success: boolean;
	path: string;
	content?: ArrayBuffer;
	contentHash?: string;
	error?: string;
}

/**
 * Handles file upload/download operations with the R2 backend
 */
export class FileSync {
	private plugin: CloudflareSyncPlugin;

	constructor(plugin: CloudflareSyncPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Get the base URL for API requests
	 */
	private get baseUrl(): string {
		return this.plugin.settings.serverUrl;
	}

	/**
	 * Get auth headers for requests
	 */
	private getHeaders(): Record<string, string> {
		return this.plugin.authManager.getAuthHeader();
	}

	// ============================================================================
	// File Operations
	// ============================================================================

	/**
	 * List all files from the server
	 */
	async listFiles(): Promise<FileMeta[]> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			const data = response.json as FileListResponse;
			// API returns { files: [...], cursor, hasMore } - no success field
			if (data.files && Array.isArray(data.files)) {
				// Decode URL-encoded paths from the server
				return data.files.map(file => ({
					...file,
					path: decodeURIComponent(file.path),
				}));
			}
			return [];
		} catch (error) {
			console.error('Failed to list files:', error);
			throw error;
		}
	}

	/**
	 * Upload a file to the server
	 */
	async uploadFile(file: TFile): Promise<UploadResult> {
		try {
			const content = await this.plugin.app.vault.readBinary(file);
			const hash = await sha256(content);

			// Get base hash for conflict detection (the version we edited from)
			const baseHash = this.plugin.settings.fileBaseHashes[file.path];

			const headers: Record<string, string> = {
				...this.getHeaders(),
				'Content-Type': this.getMimeType(file.extension),
				'X-Content-Hash': hash,
				'X-File-Mtime': file.stat.mtime.toString(),
			};

			// Include base hash if we have one (for 3-way merge on conflict)
			if (baseHash) {
				headers['X-Base-Hash'] = baseHash;
			}

			const response = await requestUrl({
				url: `${this.baseUrl}/files/${encodeURIComponent(file.path)}`,
				method: 'PUT',
				headers,
				body: content,
			});

			const data = response.json as FileUploadResponse;

			if (data.success) {
				return {
					success: true,
					path: file.path,
					contentHash: data.contentHash,
					merged: data.merged,
					hadConflict: data.hadConflict,
				};
			}

			return {
				success: false,
				path: file.path,
				error: 'Upload failed',
			};
		} catch (error) {
			console.error(`Failed to upload ${file.path}:`, error);
			return {
				success: false,
				path: file.path,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Download a file from the server
	 */
	async downloadFile(path: string): Promise<DownloadResult> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files/${encodeURIComponent(path)}`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			// Get content hash from response header
			const contentHash = response.headers['x-file-hash'] || response.headers['X-File-Hash'];

			return {
				success: true,
				path,
				content: response.arrayBuffer,
				contentHash,
			};
		} catch (error) {
			console.error(`Failed to download ${path}:`, error);
			return {
				success: false,
				path,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Clear all remote file metadata (for force re-upload)
	 */
	async clearRemoteFiles(): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files/clear`,
				method: 'POST',
				headers: this.getHeaders(),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error('Failed to clear remote files:', error);
			return false;
		}
	}

	/**
	 * Delete a file on the server
	 */
	async deleteFile(path: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files/${encodeURIComponent(path)}`,
				method: 'DELETE',
				headers: this.getHeaders(),
			});

			const data = response.json as { success: boolean };
			return data.success;
		} catch (error) {
			console.error(`Failed to delete ${path}:`, error);
			return false;
		}
	}

	/**
	 * Get file versions from server
	 */
	async getVersions(path: string): Promise<FileVersionsResponse | null> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files/${encodeURIComponent(path)}/versions`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			return response.json as FileVersionsResponse;
		} catch (error) {
			console.error(`Failed to get versions for ${path}:`, error);
			return null;
		}
	}

	/**
	 * Download a specific version of a file
	 */
	async downloadVersion(path: string, timestamp: number): Promise<DownloadResult> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/files/${encodeURIComponent(path)}/versions/${timestamp}`,
				method: 'GET',
				headers: this.getHeaders(),
			});

			return {
				success: true,
				path,
				content: response.arrayBuffer,
			};
		} catch (error) {
			console.error(`Failed to download version ${timestamp} of ${path}:`, error);
			return {
				success: false,
				path,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	// ============================================================================
	// Local File Operations
	// ============================================================================

	/**
	 * Write downloaded content to the vault
	 */
	async writeToVault(path: string, content: ArrayBuffer): Promise<boolean> {
		try {
			const existingFile = this.plugin.app.vault.getAbstractFileByPath(path);

			if (existingFile instanceof TFile) {
				// Update existing file
				await this.plugin.app.vault.modifyBinary(existingFile, content);
			} else {
				// Create new file (ensure parent directories exist)
				await this.ensureParentDirectory(path);
				await this.plugin.app.vault.createBinary(path, content);
			}

			return true;
		} catch (error) {
			console.error(`Failed to write ${path} to vault:`, error);
			return false;
		}
	}

	/**
	 * Ensure parent directory exists for a file path
	 */
	private async ensureParentDirectory(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		parts.pop(); // Remove filename

		if (parts.length === 0) {
			return;
		}

		const dirPath = parts.join('/');
		const existingFolder = this.plugin.app.vault.getAbstractFileByPath(dirPath);

		if (!existingFolder) {
			await this.plugin.app.vault.createFolder(dirPath);
		}
	}

	/**
	 * Delete a file from the vault
	 */
	async deleteFromVault(path: string): Promise<boolean> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file) {
				await this.plugin.app.vault.delete(file);
			}
			return true;
		} catch (error) {
			console.error(`Failed to delete ${path} from vault:`, error);
			return false;
		}
	}

	// ============================================================================
	// Utilities
	// ============================================================================

	/**
	 * Get MIME type for a file extension
	 */
	private getMimeType(extension: string): string {
		const mimeTypes: Record<string, string> = {
			md: 'text/markdown',
			txt: 'text/plain',
			json: 'application/json',
			js: 'application/javascript',
			css: 'text/css',
			html: 'text/html',
			xml: 'application/xml',
			svg: 'image/svg+xml',
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			gif: 'image/gif',
			webp: 'image/webp',
			pdf: 'application/pdf',
			mp3: 'audio/mpeg',
			mp4: 'video/mp4',
			webm: 'video/webm',
			wav: 'audio/wav',
			ogg: 'audio/ogg',
		};

		return mimeTypes[extension.toLowerCase()] ?? 'application/octet-stream';
	}

	/**
	 * Calculate hash of local file content
	 */
	async getLocalFileHash(file: TFile): Promise<string> {
		const content = await this.plugin.app.vault.readBinary(file);
		return sha256(content);
	}
}
