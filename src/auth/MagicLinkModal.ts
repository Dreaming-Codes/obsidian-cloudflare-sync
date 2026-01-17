import { Modal } from 'obsidian';
import { createElement, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type CloudflareSyncPlugin from '../main';
import { PluginContext } from '../ui/context/PluginContext';
import { MagicLinkView } from '../ui/components/MagicLinkView';

/**
 * Modal wrapper for React-based magic link authentication UI
 */
export class MagicLinkModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private root: Root | null = null;

	constructor(plugin: CloudflareSyncPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-modal');

		// Create React root and render the magic link view
		this.root = createRoot(contentEl);
		this.root.render(
			createElement(
				StrictMode,
				null,
				createElement(
					PluginContext.Provider,
					{ value: { app: this.app, plugin: this.plugin } },
					createElement(MagicLinkView, { onClose: () => this.close() })
				)
			)
		);
	}

	onClose(): void {
		// Cleanup React root
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
		this.contentEl.empty();
	}
}
