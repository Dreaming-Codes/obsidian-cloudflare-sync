/**
 * CommentView - UI for viewing and managing comments on files.
 */

import { Modal, Setting, Notice, TFile, TextAreaComponent } from 'obsidian';
import type CloudflareSyncPlugin from '../main';
import type { Comment } from '../types';
import { CommentManager } from './CommentManager';

/**
 * Modal for viewing and managing all comments on a file.
 */
export class CommentsModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private commentManager: CommentManager;
	private file: TFile;
	private comments: Comment[] = [];
	private isLoading = false;
	private docId: string = '';

	constructor(plugin: CloudflareSyncPlugin, file: TFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.commentManager = plugin.commentManager;
		this.file = file;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-comments-modal');

		// Title
		contentEl.createEl('h2', { text: `Comments: ${this.file.name}` });

		// Loading state
		this.isLoading = true;
		this.renderContent();

		// Get doc ID and load comments
		this.docId = await this.commentManager.getDocId(this.file.path);
		await this.loadComments();
		this.isLoading = false;
		this.renderContent();
	}

	private async loadComments(): Promise<void> {
		this.comments = await this.commentManager.listComments(this.docId);
	}

	private renderContent(): void {
		const { contentEl } = this;
		const container = contentEl.querySelector('.comments-content') as HTMLElement | null;
		if (container) {
			container.empty();
		}

		const content = container || contentEl.createDiv({ cls: 'comments-content' });
		content.empty();

		if (this.isLoading) {
			content.createEl('p', { text: 'Loading comments...', cls: 'comments-loading' });
			return;
		}

		// Add new comment section
		this.renderAddCommentSection(content);

		// Filter controls
		this.renderFilterControls(content);

		// Comments list
		this.renderCommentsList(content);
	}

	private renderAddCommentSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'comments-add-section' });
		section.createEl('h3', { text: 'Add comment' });

		let commentTextarea: TextAreaComponent;

		new Setting(section)
			.setName('Your comment')
			.addTextArea((textarea) => {
				commentTextarea = textarea;
				textarea.setPlaceholder('Write your comment...');
				textarea.inputEl.rows = 3;
				textarea.inputEl.addClass('comments-textarea');
			});

		new Setting(section).addButton((button) => {
			button
				.setButtonText('Add comment')
				.setCta()
				.onClick(async () => {
					const content = commentTextarea.getValue().trim();
					if (!content) {
						new Notice('Please enter a comment');
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Adding...');

					// For now, use an empty position (will be enhanced later for text selection)
					const position = btoa(''); // Empty base64-encoded position

					const comment = await this.commentManager.createComment(
						this.docId,
						content,
						position
					);

					if (comment) {
						new Notice('Comment added');
						commentTextarea.setValue('');
						await this.loadComments();
						this.renderContent();
					} else {
						new Notice('Failed to add comment');
					}

					button.setDisabled(false);
					button.setButtonText('Add comment');
				});
		});
	}

	private renderFilterControls(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'comments-filter-section' });

		const unresolvedCount = this.commentManager.filterUnresolved(this.comments).length;
		const resolvedCount = this.commentManager.filterResolved(this.comments).length;

		section.createEl('span', {
			text: `${this.comments.length} comment${this.comments.length !== 1 ? 's' : ''} `,
			cls: 'comments-count',
		});

		if (resolvedCount > 0) {
			section.createEl('span', {
				text: `(${unresolvedCount} open, ${resolvedCount} resolved)`,
				cls: 'comments-count-detail',
			});
		}
	}

	private renderCommentsList(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'comments-list-section' });

		if (this.comments.length === 0) {
			section.createEl('p', {
				text: 'No comments yet. Be the first to comment!',
				cls: 'comments-empty',
			});
			return;
		}

		// Build threaded comments
		const threads = this.commentManager.buildThreadedComments(this.comments);
		const topLevel = threads.get(null) || [];

		for (const comment of topLevel) {
			this.renderCommentThread(section, comment, threads);
		}
	}

	private renderCommentThread(
		container: HTMLElement,
		comment: Comment,
		threads: Map<string | null, Comment[]>,
		depth = 0
	): void {
		const item = container.createDiv({
			cls: `comment-item ${comment.resolved ? 'resolved' : ''} depth-${depth}`,
		});

		// Comment header
		const header = item.createDiv({ cls: 'comment-header' });
		header.createEl('span', { text: comment.authorEmail, cls: 'comment-author' });
		header.createEl('span', {
			text: this.commentManager.formatTimestamp(comment.createdAt),
			cls: 'comment-time',
		});

		if (comment.resolved) {
			header.createEl('span', { text: 'Resolved', cls: 'comment-resolved-badge' });
		}

		// Comment content
		const content = item.createDiv({ cls: 'comment-content' });
		content.createEl('p', { text: comment.content });

		// Comment actions
		const actions = item.createDiv({ cls: 'comment-actions' });

		// Reply button
		const replyBtn = actions.createEl('button', { text: 'Reply', cls: 'comment-action-btn' });
		replyBtn.addEventListener('click', () => {
			this.showReplyForm(item, comment);
		});

		// Resolve/Unresolve button
		const resolveBtn = actions.createEl('button', {
			text: comment.resolved ? 'Reopen' : 'Resolve',
			cls: 'comment-action-btn',
		});
		resolveBtn.addEventListener('click', async () => {
			resolveBtn.disabled = true;
			const success = comment.resolved
				? await this.commentManager.unresolveComment(this.docId, comment.id)
				: await this.commentManager.resolveComment(this.docId, comment.id);

			if (success) {
				await this.loadComments();
				this.renderContent();
			} else {
				new Notice('Failed to update comment');
				resolveBtn.disabled = false;
			}
		});

		// Delete button (only for own comments)
		const currentUserId = this.plugin.authManager.getUserId();
		if (comment.authorId === currentUserId) {
			const deleteBtn = actions.createEl('button', { text: 'Delete', cls: 'comment-action-btn danger' });
			deleteBtn.addEventListener('click', async () => {
				if (!confirm('Delete this comment and all replies?')) return;

				deleteBtn.disabled = true;
				const success = await this.commentManager.deleteComment(this.docId, comment.id);

				if (success) {
					new Notice('Comment deleted');
					await this.loadComments();
					this.renderContent();
				} else {
					new Notice('Failed to delete comment');
					deleteBtn.disabled = false;
				}
			});
		}

		// Render replies
		const replies = threads.get(comment.id) || [];
		if (replies.length > 0) {
			const repliesContainer = item.createDiv({ cls: 'comment-replies' });
			for (const reply of replies) {
				this.renderCommentThread(repliesContainer, reply, threads, depth + 1);
			}
		}
	}

	private showReplyForm(parentEl: HTMLElement, parentComment: Comment): void {
		// Remove any existing reply forms
		const existingForm = parentEl.querySelector('.comment-reply-form');
		if (existingForm) {
			existingForm.remove();
			return;
		}

		const form = parentEl.createDiv({ cls: 'comment-reply-form' });

		const textarea = form.createEl('textarea', {
			attr: { placeholder: 'Write a reply...', rows: '2' },
			cls: 'comment-reply-textarea',
		});

		const buttonContainer = form.createDiv({ cls: 'comment-reply-buttons' });

		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel', cls: 'comment-action-btn' });
		cancelBtn.addEventListener('click', () => form.remove());

		const submitBtn = buttonContainer.createEl('button', { text: 'Reply', cls: 'comment-action-btn mod-cta' });
		submitBtn.addEventListener('click', async () => {
			const content = textarea.value.trim();
			if (!content) {
				new Notice('Please enter a reply');
				return;
			}

			submitBtn.disabled = true;
			submitBtn.textContent = 'Sending...';

			const position = btoa(''); // Empty position for replies
			const comment = await this.commentManager.createComment(
				this.docId,
				content,
				position,
				parentComment.id
			);

			if (comment) {
				new Notice('Reply added');
				form.remove();
				await this.loadComments();
				this.renderContent();
			} else {
				new Notice('Failed to add reply');
				submitBtn.disabled = false;
				submitBtn.textContent = 'Reply';
			}
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Quick comment popover for adding comments from the editor.
 * This can be triggered from a text selection.
 */
export class QuickCommentModal extends Modal {
	private plugin: CloudflareSyncPlugin;
	private commentManager: CommentManager;
	private file: TFile;
	private selectedText: string;
	private position: string; // Base64-encoded position

	constructor(
		plugin: CloudflareSyncPlugin,
		file: TFile,
		selectedText: string,
		position: string
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.commentManager = plugin.commentManager;
		this.file = file;
		this.selectedText = selectedText;
		this.position = position;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('cloudflare-sync-quick-comment');

		contentEl.createEl('h3', { text: 'Add comment' });

		// Show selected text context
		if (this.selectedText) {
			const quote = contentEl.createDiv({ cls: 'quick-comment-quote' });
			quote.createEl('blockquote', { text: this.selectedText });
		}

		let textarea: TextAreaComponent;

		new Setting(contentEl).addTextArea((ta) => {
			textarea = ta;
			ta.setPlaceholder('Write your comment...');
			ta.inputEl.rows = 3;
			ta.inputEl.addClass('quick-comment-textarea');
			// Focus the textarea
			setTimeout(() => ta.inputEl.focus(), 50);
		});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((button) => {
				button
					.setButtonText('Add comment')
					.setCta()
					.onClick(async () => {
						const content = textarea.getValue().trim();
						if (!content) {
							new Notice('Please enter a comment');
							return;
						}

						button.setDisabled(true);
						button.setButtonText('Adding...');

						const docId = await this.commentManager.getDocId(this.file.path);
						const comment = await this.commentManager.createComment(
							docId,
							content,
							this.position
						);

						if (comment) {
							new Notice('Comment added');
							this.close();
						} else {
							new Notice('Failed to add comment');
							button.setDisabled(false);
							button.setButtonText('Add comment');
						}
					});
			});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
