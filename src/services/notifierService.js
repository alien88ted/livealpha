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

		// Discord webhook functionality
		this.discordWebhooks = new Map(); // clientId -> config
	}

	// Register Discord webhook configuration
	registerDiscordWebhook(clientId, config) {
		this.discordWebhooks.set(clientId, config);
		console.log(`✅ Discord webhook registered for client: ${clientId}`);
	}

	// Send Discord notification
	async sendDiscordNotification(type, data, clientId = 'default') {
		try {
			const config = this.discordWebhooks.get(clientId);
			if (!config || !config.enabled || !config.url) {
				return false;
			}

			let embed;
			let shouldSend = false;

			switch (type) {
				case 'tweet':
					if (config.notifications.allTweets && config.accounts.includes(data.username)) {
						shouldSend = true;
						embed = {
							title: `🚨 Alpha Tweet from @${data.username}`,
							description: data.text.substring(0, 500) + (data.text.length > 500 ? '...' : ''),
							color: data.isTest ? 0x007AFF : 0xFF6600,
							timestamp: new Date(data.created_at).toISOString(),
							fields: [
								{
									name: "Engagement",
									value: `❤️ ${data.like_count || 0} | 🔄 ${data.retweet_count || 0} | 💬 ${data.reply_count || 0}`,
									inline: true
								},
								{
									name: "Link",
									value: `[View Tweet](https://twitter.com/${data.username}/status/${data.id})`,
									inline: true
								}
							],
							footer: {
								text: `LiveAlpha • ${data.isTest ? 'Test' : 'Alpha'}`
							}
						};
					}
					break;

				case 'high_engagement':
					if (config.notifications.highEngagement && config.accounts.includes(data.username)) {
						const totalEngagement = (data.like_count || 0) + (data.retweet_count || 0);
						if (totalEngagement >= 1000) {
							shouldSend = true;
							embed = {
								title: `🔥 High Engagement Alert`,
								description: `@${data.username}: ${data.text.substring(0, 400)}`,
								color: 0xFF3B30,
								timestamp: new Date(data.created_at).toISOString(),
								fields: [
									{
										name: "Engagement",
										value: `❤️ ${data.like_count || 0} | 🔄 ${data.retweet_count || 0} | 💬 ${data.reply_count || 0}`,
										inline: true
									}
								]
							};
						}
					}
					break;

				case 'ai_insight':
					if (config.notifications.aiInsights) {
						shouldSend = true;
						embed = {
							title: "🤖 Alpha Insights Update",
							description: data.headline || "New market analysis available",
							color: 0xAF52DE,
							timestamp: new Date().toISOString(),
							fields: data.tickers && data.tickers.length > 0 ? [
								{
									name: "Tickers",
									value: data.tickers.join(', '),
									inline: true
								}
							] : [],
							footer: {
								text: "LiveAlpha • AI Analysis"
							}
						};
					}
					break;
			}

			if (shouldSend && embed) {
				const response = await fetch(config.url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ embeds: [embed] })
				});

				if (!response.ok) {
					console.error(`❌ Discord webhook failed: ${response.status}`);
					return false;
				}

				console.log(`✅ Discord notification sent: ${type}`);
				return true;
			}

			return false;
		} catch (error) {
			console.error('❌ Error sending Discord notification:', error.message);
			return false;
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
			// Send Telegram notification
			await this.notifyTweet(t);

			// Send Discord notifications to all registered webhooks
			for (const [clientId, config] of this.discordWebhooks) {
				await this.sendDiscordNotification('tweet', t, clientId);

				// Check for high engagement
				const totalEngagement = (t.like_count || 0) + (t.retweet_count || 0);
				if (totalEngagement >= 1000) {
					await this.sendDiscordNotification('high_engagement', t, clientId);
				}
			}
		}
	}

	// Method to be called when AI insights are updated
	async notifyAIInsights(insightData) {
		for (const [clientId, config] of this.discordWebhooks) {
			await this.sendDiscordNotification('ai_insight', insightData, clientId);
		}
	}
}

module.exports = NotifierService;
