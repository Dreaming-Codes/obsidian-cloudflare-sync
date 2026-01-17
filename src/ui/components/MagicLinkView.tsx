import { useState, useEffect, useCallback } from 'react';
import { usePlugin } from '../hooks/usePlugin';

type ModalState = 'input' | 'sending' | 'waiting' | 'verifying' | 'success' | 'error';

interface MagicLinkViewProps {
	onClose: () => void;
}

export function MagicLinkView({ onClose }: MagicLinkViewProps) {
	const { plugin } = usePlugin();
	const [email, setEmail] = useState('');
	const [token, setToken] = useState('');
	const [state, setState] = useState<ModalState>('input');
	const [errorMessage, setErrorMessage] = useState('');
	const [waitingSeconds, setWaitingSeconds] = useState(0);

	// Timer for waiting state
	useEffect(() => {
		if (state !== 'waiting') return;

		const interval = setInterval(() => {
			setWaitingSeconds((s) => s + 1);
		}, 1000);

		return () => clearInterval(interval);
	}, [state]);

	const formatTime = (seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	};

	const isValidEmail = (email: string): boolean => {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		return emailRegex.test(email);
	};

	const handleSendMagicLink = useCallback(async () => {
		if (!isValidEmail(email)) {
			setErrorMessage('Please enter a valid email address');
			setState('error');
			return;
		}

		setState('sending');

		const success = await plugin.authManager.requestMagicLink(email);

		if (success) {
			setState('waiting');
			setWaitingSeconds(0);
		} else {
			setErrorMessage('Failed to send magic link. Please try again.');
			setState('error');
		}
	}, [email, plugin.authManager]);

	const handleVerifyToken = useCallback(
		async (tokenValue: string) => {
			if (tokenValue.length < 10) return;

			setState('verifying');

			const success = await plugin.authManager.verifyToken(tokenValue);

			if (success) {
				setState('success');
				// Auto-close after 2 seconds
				setTimeout(() => {
					onClose();
				}, 2000);
			} else {
				setErrorMessage('Invalid or expired token. Please try again.');
				setState('error');
			}
		},
		[plugin.authManager, onClose]
	);

	const handleReset = () => {
		setWaitingSeconds(0);
		setErrorMessage('');
		setToken('');
		setState('input');
	};

	switch (state) {
		case 'input':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Login to Cloudflare Sync</h2>
					<p className="setting-item-description">
						Enter your email address to receive a verification code.
					</p>

					<div className="setting-item">
						<div className="setting-item-info">
							<div className="setting-item-name">Email address</div>
						</div>
						<div className="setting-item-control">
							<input
								type="email"
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value.trim())}
								onKeyDown={(e) => {
									if (e.key === 'Enter') handleSendMagicLink();
								}}
							/>
						</div>
					</div>

					<div className="setting-item">
						<div className="setting-item-control">
							<button className="mod-cta" onClick={handleSendMagicLink}>
								Send verification code
							</button>
						</div>
					</div>
				</div>
			);

		case 'sending':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Sending verification code...</h2>
					<p>Sending code to {email}</p>
					<div className="cloudflare-sync-loading">
						<span>Please wait...</span>
					</div>
				</div>
			);

		case 'waiting':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Check your email</h2>
					<p>We sent a verification code to {email}.</p>

					<div className="cloudflare-sync-timer">
						<span>Waiting... {formatTime(waitingSeconds)}</span>
					</div>

					<div className="setting-item">
						<div className="setting-item-info">
							<div className="setting-item-name">Enter verification code</div>
							<div className="setting-item-description">
								Paste the code from your email
							</div>
						</div>
						<div className="setting-item-control">
							<input
								type="text"
								placeholder="Paste code here"
								value={token}
								onChange={(e) => {
									const value = e.target.value.trim();
									setToken(value);
									if (value.length > 10) {
										handleVerifyToken(value);
									}
								}}
							/>
						</div>
					</div>

					<p className="setting-item-description">
						Didn't receive the email? Check your spam folder or try again.
					</p>

					<div className="setting-item">
						<div className="setting-item-control">
							<button onClick={handleReset}>Send again</button>
							<button onClick={onClose}>Cancel</button>
						</div>
					</div>
				</div>
			);

		case 'verifying':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Verifying...</h2>
					<p>Completing your login...</p>
					<div className="cloudflare-sync-loading">
						<span>Please wait...</span>
					</div>
				</div>
			);

		case 'success':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Login successful!</h2>
					<p>You are now logged in as {plugin.settings.userEmail}</p>
					<div className="setting-item">
						<div className="setting-item-control">
							<button className="mod-cta" onClick={onClose}>
								Done
							</button>
						</div>
					</div>
				</div>
			);

		case 'error':
			return (
				<div className="cloudflare-sync-modal">
					<h2>Login failed</h2>
					<p className="cloudflare-sync-error">
						{errorMessage || 'An error occurred. Please try again.'}
					</p>
					<div className="setting-item">
						<div className="setting-item-control">
							<button onClick={handleReset}>Try again</button>
							<button onClick={onClose}>Cancel</button>
						</div>
					</div>
				</div>
			);
	}
}
