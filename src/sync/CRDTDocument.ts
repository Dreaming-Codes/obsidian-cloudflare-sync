/**
 * CRDT Document wrapper using Y.js for real-time collaboration.
 * Manages a Y.Doc for each file and handles sync with the server.
 */

import * as Y from 'yjs';

export interface CRDTDocumentEvents {
	onLocalUpdate: (update: Uint8Array) => void;
	onRemoteUpdate: () => void;
}

export class CRDTDocument {
	private doc: Y.Doc;
	private text: Y.Text;
	private events: CRDTDocumentEvents;
	private isApplyingRemote = false;
	private destroyed = false;

	constructor(
		public readonly docId: string,
		events: CRDTDocumentEvents
	) {
		this.events = events;
		this.doc = new Y.Doc();
		this.text = this.doc.getText('content');

		// Listen for local updates
		this.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (this.destroyed) return;
			
			// Only emit if this is a local update (not from remote)
			if (origin !== 'remote') {
				this.events.onLocalUpdate(update);
			}
		});
	}

	/**
	 * Get the current text content.
	 */
	getContent(): string {
		return this.text.toString();
	}

	/**
	 * Set the entire text content (replaces everything).
	 */
	setContent(content: string): void {
		this.doc.transact(() => {
			this.text.delete(0, this.text.length);
			this.text.insert(0, content);
		});
	}

	/**
	 * Insert text at a position.
	 */
	insert(index: number, text: string): void {
		this.doc.transact(() => {
			this.text.insert(index, text);
		});
	}

	/**
	 * Delete text at a position.
	 */
	delete(index: number, length: number): void {
		this.doc.transact(() => {
			this.text.delete(index, length);
		});
	}

	/**
	 * Apply a change from the editor.
	 */
	applyChange(from: number, to: number, text: string): void {
		if (this.isApplyingRemote) return;

		this.doc.transact(() => {
			// Delete the range first
			if (to > from) {
				this.text.delete(from, to - from);
			}
			// Insert the new text
			if (text.length > 0) {
				this.text.insert(from, text);
			}
		});
	}

	/**
	 * Get the state vector for this document.
	 */
	getStateVector(): Uint8Array {
		return Y.encodeStateVector(this.doc);
	}

	/**
	 * Get the full document state as an update.
	 */
	getFullState(): Uint8Array {
		return Y.encodeStateAsUpdate(this.doc);
	}

	/**
	 * Get updates missing from the given state vector.
	 */
	getMissingUpdates(stateVector: Uint8Array): Uint8Array {
		return Y.encodeStateAsUpdate(this.doc, stateVector);
	}

	/**
	 * Apply a remote update.
	 */
	applyRemoteUpdate(update: Uint8Array): void {
		if (this.destroyed) return;

		this.isApplyingRemote = true;
		try {
			Y.applyUpdate(this.doc, update, 'remote');
			this.events.onRemoteUpdate();
		} finally {
			this.isApplyingRemote = false;
		}
	}

	/**
	 * Apply the full state from the server.
	 */
	applyFullState(state: Uint8Array): void {
		if (state.length === 0) return;
		this.applyRemoteUpdate(state);
	}

	/**
	 * Check if we're currently applying a remote update.
	 */
	isApplyingRemoteUpdate(): boolean {
		return this.isApplyingRemote;
	}

	/**
	 * Subscribe to text changes.
	 */
	observeText(callback: (event: Y.YTextEvent) => void): void {
		this.text.observe(callback);
	}

	/**
	 * Unsubscribe from text changes.
	 */
	unobserveText(callback: (event: Y.YTextEvent) => void): void {
		this.text.unobserve(callback);
	}

	/**
	 * Get the underlying Y.Doc (for advanced use cases).
	 */
	getYDoc(): Y.Doc {
		return this.doc;
	}

	/**
	 * Get the underlying Y.Text (for advanced use cases).
	 */
	getYText(): Y.Text {
		return this.text;
	}

	/**
	 * Destroy the document and clean up resources.
	 */
	destroy(): void {
		this.destroyed = true;
		this.doc.destroy();
	}
}

/**
 * Manager for multiple CRDT documents.
 */
export class CRDTDocumentManager {
	private documents: Map<string, CRDTDocument> = new Map();
	private onLocalUpdate: (docId: string, update: Uint8Array) => void;
	private onRemoteUpdate: (docId: string) => void;

	constructor(
		onLocalUpdate: (docId: string, update: Uint8Array) => void,
		onRemoteUpdate: (docId: string) => void
	) {
		this.onLocalUpdate = onLocalUpdate;
		this.onRemoteUpdate = onRemoteUpdate;
	}

	/**
	 * Get or create a CRDT document for a file.
	 */
	getOrCreate(docId: string): CRDTDocument {
		let doc = this.documents.get(docId);
		if (!doc) {
			doc = new CRDTDocument(docId, {
				onLocalUpdate: (update) => this.onLocalUpdate(docId, update),
				onRemoteUpdate: () => this.onRemoteUpdate(docId),
			});
			this.documents.set(docId, doc);
		}
		return doc;
	}

	/**
	 * Get a document if it exists.
	 */
	get(docId: string): CRDTDocument | undefined {
		return this.documents.get(docId);
	}

	/**
	 * Check if a document exists.
	 */
	has(docId: string): boolean {
		return this.documents.has(docId);
	}

	/**
	 * Remove and destroy a document.
	 */
	remove(docId: string): void {
		const doc = this.documents.get(docId);
		if (doc) {
			doc.destroy();
			this.documents.delete(docId);
		}
	}

	/**
	 * Get all document IDs.
	 */
	getDocIds(): string[] {
		return Array.from(this.documents.keys());
	}

	/**
	 * Destroy all documents.
	 */
	destroyAll(): void {
		for (const doc of this.documents.values()) {
			doc.destroy();
		}
		this.documents.clear();
	}
}
