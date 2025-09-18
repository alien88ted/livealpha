const DEFAULT_HOURS = 24;

class NotifierService {
	constructor() {
		this.telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
		this.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
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
