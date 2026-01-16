/**
 * Utility functions for file hashing
 */

/**
 * Calculate SHA-256 hash of content using Web Crypto API
 */
export async function sha256(content: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', content);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate hash of a string
 */
export async function hashString(str: string): Promise<string> {
	const encoder = new TextEncoder();
	return sha256(encoder.encode(str).buffer as ArrayBuffer);
}

/**
 * Calculate a short hash for file path (for R2 storage keys)
 */
export async function hashPath(path: string): Promise<string> {
	const hash = await hashString(path);
	return hash.substring(0, 16); // Use first 16 chars for shorter keys
}
