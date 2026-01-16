import { Modal, Setting } from 'obsidian';
import type CloudflareSyncPlugin from '../main';

type ModalState = 'input' | 'sending' | 'waiting' | 'verifying' | 'success' | 'error';

/**
 * Modal for magic link email authentication
 */
export class MagicLinkModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private email: string = '';
	private state: ModalState = 'input';
	private errorMessage: string = '';
	private waitingTimer: ReturnType<typeof setInterval> | null = null;
	private waitingSeconds: number = 0;

	constructor(plugin: CloudflareSyncPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		if (this.waitingTimer) {
			clearInterval(this.waitingTimer);
			this.waitingTimer = null;
		}
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-modal');

		switch (this.state) {
			case 'input':
				this.renderInputState();
				break;
			case 'sending':
				this.renderSendingState();
				break;
			case 'waiting':
				this.renderWaitingState();
				break;
			case 'verifying':
				this.renderVerifyingState();
				break;
			case 'success':
				this.renderSuccessState();
				break;
			case 'error':
				this.renderErrorState();
				break;
		}
	}

	private renderInputState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Login to Cloudflare Sync' });
		contentEl.createEl('p', {
			text: "Enter your email address to receive a magic link. Click the link in the email to log in.",
			cls: 'setting-item-description',
		});

		new Setting(contentEl)
			.setName('Email address')
			.addText((text) =>
				text
					.setPlaceholder('you@example.com')
					.setValue(this.email)
					.onChange((value) => {
						this.email = value.trim();
					}),
			);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('Send magic link')
				.setCta()
				.onClick(() => this.sendMagicLink()),
		);
	}

	private renderSendingState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Sending magic link...' });
		contentEl.createEl('p', { text: `Sending login link to ${this.email}` });

		const loadingEl = contentEl.createDiv({ cls: 'cloudflare-sync-loading' });
		loadingEl.createSpan({ text: 'Please wait...' });
	}

	private renderWaitingState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Check your email' });
		contentEl.createEl('p', {
			text: `We sent a magic link to ${this.email}. Click the link in the email to log in.`,
		});

		const timerEl = contentEl.createDiv({ cls: 'cloudflare-sync-timer' });
		timerEl.createSpan({ text: `Waiting... ${this.formatTime(this.waitingSeconds)}` });

		contentEl.createEl('p', {
			text: "Didn't receive the email? Check your spam folder or try again.",
			cls: 'setting-item-description',
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Send again').onClick(() => {
					this.resetToInput();
				}),
			)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			);

		// Manual token input for advanced users
		new Setting(contentEl)
			.setName('Or enter token manually')
			.setDesc('If you have a token from the email link')
			.addText((text) =>
				text.setPlaceholder('Paste token here').onChange(async (value) => {
					if (value.length > 10) {
						await this.verifyToken(value.trim());
					}
				}),
			);
	}

	private renderVerifyingState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Verifying...' });
		contentEl.createEl('p', { text: 'Completing your login...' });

		const loadingEl = contentEl.createDiv({ cls: 'cloudflare-sync-loading' });
		loadingEl.createSpan({ text: 'Please wait...' });
	}

	private renderSuccessState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Login successful!' });
		contentEl.createEl('p', { text: `You are now logged in as ${this.plugin.settings.userEmail}` });

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('Done')
				.setCta()
				.onClick(() => {
					this.close();
				}),
		);

		// Auto-close after 2 seconds
		setTimeout(() => {
			if (this.state === 'success') {
				this.close();
			}
		}, 2000);
	}

	private renderErrorState(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Login failed' });
		contentEl.createEl('p', {
			text: this.errorMessage || 'An error occurred. Please try again.',
			cls: 'cloudflare-sync-error',
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Try again').onClick(() => {
					this.resetToInput();
				}),
			)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			);
	}

	private async sendMagicLink(): Promise<void> {
		if (!this.isValidEmail(this.email)) {
			this.errorMessage = 'Please enter a valid email address';
			this.state = 'error';
			this.render();
			return;
		}

		this.state = 'sending';
		this.render();

		const success = await this.plugin.authManager.requestMagicLink(this.email);

		if (success) {
			this.state = 'waiting';
			this.waitingSeconds = 0;
			this.startWaitingTimer();
		} else {
			this.errorMessage = 'Failed to send magic link. Please try again.';
			this.state = 'error';
		}

		this.render();
	}

	private async verifyToken(token: string): Promise<void> {
		this.state = 'verifying';
		this.render();

		const success = await this.plugin.authManager.verifyToken(token);

		if (success) {
			this.state = 'success';
		} else {
			this.errorMessage = 'Invalid or expired token. Please try again.';
			this.state = 'error';
		}

		this.render();
	}

	private startWaitingTimer(): void {
		if (this.waitingTimer) {
			clearInterval(this.waitingTimer);
		}

		this.waitingTimer = setInterval(() => {
			this.waitingSeconds++;
			// Re-render to update the timer display
			if (this.state === 'waiting') {
				const timerEl = this.contentEl.querySelector('.cloudflare-sync-timer span');
				if (timerEl) {
					timerEl.textContent = `Waiting... ${this.formatTime(this.waitingSeconds)}`;
				}
			}
		}, 1000);
	}

	private resetToInput(): void {
		if (this.waitingTimer) {
			clearInterval(this.waitingTimer);
			this.waitingTimer = null;
		}
		this.waitingSeconds = 0;
		this.errorMessage = '';
		this.state = 'input';
		this.render();
	}

	private formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	private isValidEmail(email: string): boolean {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		return emailRegex.test(email);
	}
}
