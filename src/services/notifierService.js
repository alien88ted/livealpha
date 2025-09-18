const DEFAULT_HOURS = 24;

class NotifierService {
	constructor() {
		this.telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
		this.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
		this.telegramAdminUsername = (process.env.TELEGRAM_ADMIN_USERNAME || '@cedarz19').toLowerCase();
		this.enabled = Boolean(this.telegramToken && this.telegramChatId);
		if (!this.enabled) {
			console.log('ℹ️  Telegram notifier disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)');
		}
	}

	isFreshWithinHours(dateString, hours = DEFAULT_HOURS) {
		if (!dateString) return false;
		const created = new Date(dateString).getTime();
		return Date.now() - created <= hours * 60 * 60 * 1000;
	}

	async sendTelegramMessage(text) {
		if (!this.enabled) return;
		try {
			const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
			await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chat_id: this.telegramChatId, text, disable_web_page_preview: true })
			});
		} catch (err) {
			console.error('❌ Telegram send error:', err.message || err);
		}
	}

	// Admin-only: parse messages via getUpdates and allow adding accounts with /add @username
	async fetchTelegramUpdates(offset = undefined) {
		if (!this.enabled) return [];
		const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates` + (offset ? `?offset=${offset}` : '');
		const res = await fetch(url);
		const data = await res.json();
		return data.result || [];
	}

	async processAdminCommands(onAddAccount) {
		try {
			let offset;
			const updates = await this.fetchTelegramUpdates();
			if (updates.length === 0) return;
			for (const u of updates) {
				offset = u.update_id + 1;
				const msg = u.message || u.channel_post;
				if (!msg || !msg.text) continue;
				const fromUser = (msg.from?.username ? `@${msg.from.username}` : '').toLowerCase();
				if (fromUser !== this.telegramAdminUsername) continue; // only admin can control
				const text = msg.text.trim();
				const addMatch = text.match(/^\/add\s+@?([A-Za-z0-9_]{2,50})$/i);
				if (addMatch) {
					const username = addMatch[1];
					await onAddAccount(username);
					await this.sendTelegramMessage(`Added @${username} to monitor list.`);
				}
			}
			// acknowledge updates by requesting next offset
			if (offset) await this.fetchTelegramUpdates(offset);
		} catch (e) {
			console.error('❌ Telegram admin command error:', e.message || e);
		}
	}

	formatTweetMessage(tweet) {
		const username = tweet.username || 'unknown';
		const url = tweet.url || `https://twitter.com/${username}/status/${tweet.id}`;
		const prefix = tweet.isTest ? '🧪 TEST' : '🚨 FRESH';
		const text = (tweet.text || '').trim();
		return `${prefix} @${username}\n${text}\n${url}`;
	}

	async notifyTweet(tweet) {
		if (!tweet) return;
		if (!this.isFreshWithinHours(tweet.created_at, DEFAULT_HOURS)) return;
		const message = this.formatTweetMessage(tweet);
		await this.sendTelegramMessage(message);
	}

	async notifyNewTweets(tweets) {
		if (!Array.isArray(tweets) || tweets.length === 0) return;
		for (const t of tweets) {
			await this.notifyTweet(t);
		}
	}
}

module.exports = NotifierService;
