const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk').default;
const { getPool } = require('../config/database');
const { calculateCostUsd, getPricingForModel, DEFAULT_BUDGET_USD } = require('../config/aiPricing');

class AIService {
	constructor() {
		this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
		this.maxTweetsForContext = 120; // cap to stay within token limits
		this.haikuModel = process.env.AI_HAIKU_MODEL || 'claude-3-5-haiku-20241022';
		this.opusModel = process.env.AI_OPUS_MODEL || 'claude-opus-4-1-20250805';
		this.sonnetModel = process.env.AI_SONNET_MODEL || 'claude-sonnet-4-20250514';
		this.haikuMaxTokens = 2048;
		this.opusMaxTokens = 3000; // Reduced from 4000
		this.sonnetMaxTokens = 20000;
		this.temperature = 0.3;
		this.digestIntervalMs = 60 * 60 * 1000; // 1h
		this.urgentCooldownMs = 15 * 60 * 1000; // 15 minutes cooldown for urgent alerts (was 5min)

		// Alert deduplication settings
		this.recentAlerts = new Map(); // message hash -> timestamp
		this.alertSimilarityThreshold = 0.8; // 80% similarity = duplicate
		this.maxAlertsPerHour = 4; // Maximum urgent alerts per hour

		// AI Budget Management - Target $300/month total
		this.dailyBudgets = {
			opus: 3.33,    // $100/month for critical analysis only
			sonnet: 5.00,  // $150/month for main analysis
			haiku: 1.67    // $50/month for quick decisions
		};
		this.dailySpend = { opus: 0, sonnet: 0, haiku: 0 };

		// Model selection thresholds
		this.opusMinIntervalMs = 30 * 60 * 1000; // 30 minutes minimum between Opus calls
		this.sonnetMinIntervalMs = 8 * 60 * 1000; // 8 minutes between Sonnet calls
		this.opusMinTweetThreshold = 8; // Need 8+ new tweets for Opus
		this.sonnetMinTweetThreshold = 3; // Need 3+ new tweets for Sonnet

		// AI Usage Tracking
		this.usage = {
			daily: { opus: 0, sonnet: 0, haiku: 0, cost: 0 },
			monthly: { opus: 0, sonnet: 0, haiku: 0, cost: 0 },
			session: { requests: 0, tokens: 0, cost: 0, startTime: Date.now() }
		};
		this.costs = {
			'claude-opus-4-1-20250805': { input: 0.015, output: 0.075 }, // per 1k tokens
			'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
			'claude-3-5-haiku-20241022': { input: 0.0001, output: 0.0005 }
		};
        this.monthlyBudget = parseFloat(process.env.AI_MONTHLY_BUDGET || String(DEFAULT_BUDGET_USD));
		this.state = {
			phase: 'idle',
			running: false,
			lastOpusAt: null,
			lastHaikuFlashAt: null,
			lastSonnetAt: null,
			lastDigestAt: null,
			lastInsightAt: null,
			lastCompactAt: null,
			lastUrgentAt: null,
			lastHaikuDecisionAt: null,
			lastHaikuUrgent: false,
			lastHaikuChange: false
		};
		this.logs = [];
	}

	sanitizeForTelegram(text) {
		if (!text) return '';
		return String(text)
			.replace(/[\*`_~>|#]/g, '') // remove markdown-ish chars
			.replace(/\s+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	logEvent(type, details = {}) {
		try {
			this.logs.push({ ts: new Date().toISOString(), type, ...details });
			if (this.logs.length > 200) this.logs.shift();
		} catch {}
	}

	static computeChecksum(text) {
		return crypto.createHash('sha256').update(text).digest('hex');
	}

	formatTweetsForPrompt(tweets) {
		const recent = [...tweets]
			.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
			.slice(0, this.maxTweetsForContext);
		return recent
			.map(t => `@${t.username} | ${new Date(t.created_at).toISOString()} | ${t.text}`)
			.join('\n');
	}

	buildPrompt(tweetsText) {
		return `You will be analyzing a collection of tweets from influential crypto Twitter accounts to identify current trends, emerging opportunities, and market sentiment. Your goal is to extract actionable insights about what's currently popular, what's gaining traction, and what's losing momentum in the crypto space.\n\n<tweets>\n${tweetsText}\n</tweets>\n\nYour task is to analyze these tweets to understand the current crypto landscape and provide a structured summary of trends and sentiment.\n\nHere's what each category should contain:\n\n**Hot now**: Projects, tokens, platforms, or narratives that are being discussed frequently across multiple accounts right now. These should be trending topics with high current engagement.\n\n**Emerging (new)**: Projects, tokens, or trends that are just starting to gain attention. Look for mentions that seem fresh, early-stage discussions, or things that only a few accounts are talking about but seem promising.\n\n**Dying**: Projects, tokens, or narratives that appear to be losing momentum based on decreased mentions, negative sentiment, or accounts moving away from discussing them.\n\n**AI Pick**: Based on your analysis, identify one particularly interesting opportunity or trend that stands out as potentially significant, even if it's not the most discussed.\n\nWhen analyzing the tweets, pay attention to:\n- Ticker symbols and project names being mentioned\n- Platforms and ecosystems being discussed (e.g., Ethereum, Solana, etc.)\n- Recurring themes or narratives\n- Sentiment indicators (excitement, concern, skepticism)\n- Frequency of mentions across different accounts\n- Any unusual or outlier discussions that might signal new trends\n\nFormat your response exactly as follows:\n\n**Hot now:**\n[List 3-5 items with brief explanations]\n\n**Emerging (new):**\n[List 2-4 items with brief explanations]\n\n**Dying:**\n[List 2-3 items with brief explanations]\n\n**AI Pick:**\n[One item with detailed reasoning for why it's interesting]\n\n**Overall Sentiment:**\n[2-3 lines describing the general mood and outlook in crypto Twitter based on these tweets]\n\nFocus on being specific about tickers, platforms, and concrete trends rather than vague generalizations. Include reasoning for your categorizations based on what you observe in the tweet patterns and content.`;
	}

	async getCachedInsight(checksum, model) {
		const pool = getPool();
		const [rows] = await pool.execute(
			`SELECT content FROM ai_insights WHERE checksum = ? AND model = ? ORDER BY created_at DESC LIMIT 1`,
			[checksum, model]
		);
		return rows.length ? rows[0].content : null;
	}

	async getLatestInsightRow() {
		const pool = getPool();
		const [rows] = await pool.execute(
			`SELECT content, created_at, checksum, model FROM ai_insights ORDER BY created_at DESC LIMIT 1`
		);
		return rows.length ? rows[0] : null;
	}

	/**
	 * Get past Opus analyses for context and tracking
	 */
	async getPastOpusAnalyses(limit = 10) {
		try {
			const pool = getPool();
			const [rows] = await pool.execute(
				`SELECT content, created_at, checksum, model
				 FROM ai_insights
				 WHERE model LIKE '%opus%'
				 ORDER BY created_at DESC
				 LIMIT ?`,
				[limit]
			);
			return rows.map(row => ({
				...row,
				summary: this.extractOpusSummary(row.content),
				timeAgo: this.timeAgo(row.created_at)
			}));
		} catch (error) {
			console.error('❌ Error fetching past Opus analyses:', error.message);
			return [];
		}
	}

	/**
	 * Extract key points from Opus analysis for display
	 */
	extractOpusSummary(content) {
		if (!content) return 'No content';

		const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

		// Extract Hot now section
		const hotIdx = lines.findIndex(l => l.toLowerCase().includes('hot now'));
		const emergingIdx = lines.findIndex(l => l.toLowerCase().includes('emerging'));
		const aiPickIdx = lines.findIndex(l => l.toLowerCase().includes('ai pick'));

		let summary = '';

		if (hotIdx !== -1) {
			const hotSection = lines.slice(hotIdx + 1, emergingIdx > hotIdx ? emergingIdx : hotIdx + 4)
				.filter(l => l && !l.startsWith('**'))
				.slice(0, 2)
				.join('. ');
			summary += `Hot: ${hotSection}`;
		}

		if (aiPickIdx !== -1) {
			const aiPick = lines.slice(aiPickIdx + 1, aiPickIdx + 3)
				.filter(l => l && !l.startsWith('**'))
				.join('. ');
			if (aiPick) summary += ` | AI Pick: ${aiPick}`;
		}

		// Extract tickers
		const tickers = (content.match(/\$[A-Z]{2,10}/g) || []).slice(0, 5);
		if (tickers.length > 0) {
			summary = `${tickers.join(' ')} - ${summary}`;
		}

		return summary.slice(0, 200) + (summary.length > 200 ? '...' : '');
	}

	/**
	 * Format time ago helper
	 */
	timeAgo(timestamp) {
		const now = new Date();
		const time = new Date(timestamp);
		const diffMs = now - time;
		const diffMins = Math.floor(diffMs / (1000 * 60));
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return time.toLocaleDateString();
	}

	async saveInsight(checksum, model, content) {
		const pool = getPool();
		await pool.execute(
			`INSERT INTO ai_insights (checksum, model, content) VALUES (?, ?, ?)
			 ON DUPLICATE KEY UPDATE content = VALUES(content)`,
			[checksum, model, content]
		);
	}

	async runModel(model, maxTokens, promptText, meta = {}) {
		const startTime = Date.now();
		const params = {
			model,
			max_tokens: maxTokens,
			temperature: this.temperature,
			messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }]
		};
		if (meta && meta.responseFormat === 'json_object') {
			params.response_format = { type: 'json_object' };
		}
		const res = await this.client.messages.create(params);

		// Track usage
		const inputTokens = res.usage?.input_tokens || 0;
		const outputTokens = res.usage?.output_tokens || 0;
		const executionTime = Date.now() - startTime;

        await this.trackUsage(model, inputTokens, outputTokens, executionTime, meta);

		const part = (res?.content && res.content[0] && res.content[0].type === 'text') ? res.content[0].text : JSON.stringify(res);
		return part;
	}

    async trackUsage(model, inputTokens, outputTokens, executionTime, meta = {}) {
		try {
            const pricing = getPricingForModel(model);
            const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000;

			// Track spending by model for budget control
			if (model.includes('opus')) {
				this.dailySpend.opus += cost;
			} else if (model.includes('sonnet')) {
				this.dailySpend.sonnet += cost;
			} else if (model.includes('haiku')) {
				this.dailySpend.haiku += cost;
			}

			// Update session usage
			this.usage.session.requests++;
			this.usage.session.tokens += (inputTokens + outputTokens);
			this.usage.session.cost += cost;

			// Update daily/monthly usage (simplified - in production use proper date handling)
			const modelType = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : 'haiku';
			this.usage.daily[modelType]++;
			this.usage.daily.cost += cost;
			this.usage.monthly[modelType]++;
			this.usage.monthly.cost += cost;

            // Store in database (gracefully handle missing table)
			try {
				const pool = getPool();
                const detailed = calculateCostUsd(model, inputTokens, outputTokens);
                await pool.execute(
                    `INSERT INTO ai_runs (model, prompt_tokens, completion_tokens, input_cost_usd, output_cost_usd, checksum, purpose)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [model, inputTokens, outputTokens, detailed.inputCostUsd, detailed.outputCostUsd, meta.checksum || null, meta.purpose || null]
                );
			} catch (dbError) {
				// Table might not exist yet - just log the error but don't fail
                if (!dbError.message || !dbError.message.includes("doesn't exist")) {
					console.error('❌ Database error tracking AI usage:', dbError.message);
				}
			}

			this.logEvent('usage_tracked', { model, inputTokens, outputTokens, cost, executionTime });
		} catch (error) {
			console.error('❌ Error tracking AI usage:', error.message);
		}
	}

	/**
	 * Smart model selection based on context and budget
	 */
	selectOptimalModel(tweets, urgency = 'normal') {
		const newTweetCount = tweets.filter(t => {
			const tweetAge = Date.now() - new Date(t.created_at).getTime();
			return tweetAge < 10 * 60 * 1000; // Last 10 minutes
		}).length;

		const timeSinceLastOpus = Date.now() - (this.state.lastOpusAt || 0);
		const timeSinceLastSonnet = Date.now() - (this.state.lastSonnetAt || 0);

		// Check budget constraints
		const opusBudgetOk = this.dailySpend.opus < this.dailyBudgets.opus;
		const sonnetBudgetOk = this.dailySpend.sonnet < this.dailyBudgets.sonnet;

		// Opus: Only for major market events with high tweet volume
		if (urgency === 'critical' ||
			(newTweetCount >= this.opusMinTweetThreshold &&
			 timeSinceLastOpus >= this.opusMinIntervalMs &&
			 opusBudgetOk)) {
			return { model: this.opusModel, maxTokens: this.opusMaxTokens, type: 'opus' };
		}

		// Sonnet: Main workhorse for regular analysis
		if (newTweetCount >= this.sonnetMinTweetThreshold &&
			timeSinceLastSonnet >= this.sonnetMinIntervalMs &&
			sonnetBudgetOk) {
			return { model: this.sonnetModel, maxTokens: this.sonnetMaxTokens, type: 'sonnet' };
		}

		// Haiku: Quick decisions and filtering
		return { model: this.haikuModel, maxTokens: this.haikuMaxTokens, type: 'haiku' };
	}

	/**
	 * Check if we can afford a model call
	 */
	canAffordModelCall(modelType, estimatedCost = 1.0) {
		const budget = this.dailyBudgets[modelType];
		const spent = this.dailySpend[modelType];
		return (spent + estimatedCost) <= budget;
	}

	getUsageStats() {
		const sessionDuration = (Date.now() - this.usage.session.startTime) / 1000 / 60; // minutes
		const totalDailyBudget = Object.values(this.dailyBudgets).reduce((a, b) => a + b, 0);
		const totalDailySpend = Object.values(this.dailySpend).reduce((a, b) => a + b, 0);
		const budgetUsed = (totalDailySpend / totalDailyBudget) * 100;

		return {
			session: {
				...this.usage.session,
				duration: Math.round(sessionDuration),
				avgCostPerRequest: this.usage.session.requests > 0 ? this.usage.session.cost / this.usage.session.requests : 0
			},
			daily: {
				...this.usage.daily,
				spend: this.dailySpend,
				budgets: this.dailyBudgets,
				totalSpend: totalDailySpend,
				totalBudget: totalDailyBudget
			},
			monthly: {
				...this.usage.monthly,
				budget: this.monthlyBudget,
				budgetUsed: Math.round(budgetUsed),
				remaining: this.monthlyBudget - this.usage.monthly.cost
			},
			efficiency: {
				costPerInsight: this.usage.session.cost / Math.max(this.usage.session.requests, 1),
				tokensPerMinute: sessionDuration > 0 ? this.usage.session.tokens / sessionDuration : 0
			}
		};
	}

	async decideShouldRunOpus(tweets) {
		const text = this.formatTweetsForPrompt(tweets);
		const prompt = `You will get tweets and must return ONLY a JSON with keys: {\"change\": boolean, \"reason\": string, \"urgent\": boolean}. Set change=true if the landscape likely changed meaningfully since last analysis. Set urgent=true if the change is time-sensitive and should be pushed to Telegram immediately.\n\n<tweets>\n${text}\n</tweets>`;
		try {
			const out = await this.runModel(this.haikuModel, this.haikuMaxTokens, prompt);
			const parsed = JSON.parse(out.trim());
			return { change: Boolean(parsed.change), urgent: Boolean(parsed.urgent) };
		} catch {
			return { change: true, urgent: false }; // fail-open
		}
	}

	async analyzeTweets(tweets) {
		this.state.phase = 'opus';
		this.state.running = true;
		this.logEvent('opus_start');
		const text = this.formatTweetsForPrompt(tweets);
		const checksum = AIService.computeChecksum(text);
		const cached = await this.getCachedInsight(checksum, this.opusModel);
		if (cached) return { content: cached, cached: true };

		const { change, urgent } = await this.decideShouldRunOpus(tweets);
		this.state.lastHaikuDecisionAt = new Date();
		this.state.lastHaikuUrgent = urgent;
		this.state.lastHaikuChange = change;
		if (!change) {
			return { content: null, cached: false, skipped: true };
		}

		const prompt = this.buildPrompt(text);
		const content = await this.runModel(this.opusModel, this.opusMaxTokens, prompt);
		await this.saveInsight(checksum, this.opusModel, content);
		this.state.lastOpusAt = new Date();
		this.state.lastInsightAt = this.state.lastOpusAt;
		this.logEvent('opus_done', { checksum });


		// Notify if urgent (use compact plain text)
		if (urgent && global.notify) {
			try {
				let compact = { tickers: [], headline: '' };
				try { compact = await this.compactFromContent(content); } catch {}
				const tick = (compact.tickers || []).slice(0, 6).join(' ');
				const line = this.sanitizeForTelegram(`URGENT: ${tick} — ${compact.headline}`);
				await global.notify([{ username: 'AI', id: checksum, text: line.slice(0, 300), created_at: new Date().toISOString(), url: 'AI://insight', isTest: false }]);
			} catch {}
		}

		this.state.running = false;
		return { content, cached: false };
	}

	async analyzeTweetsBaseline(tweets) {
		const text = this.formatTweetsForPrompt(tweets);
		const checksum = AIService.computeChecksum(text);
		const prompt = this.buildPrompt(text);
		const content = await this.runModel(this.opusModel, this.opusMaxTokens, prompt);
		await this.saveInsight(checksum, this.opusModel, content);
		this.state.lastOpusAt = new Date();
		this.state.lastInsightAt = this.state.lastOpusAt;
		this.logEvent('opus_baseline', { checksum });
		return { content, cached: false };
	}

	// Digest/urgent cadence state
	async getNotifyState() {
		const pool = getPool();
		const [rows] = await pool.execute(`SELECT * FROM ai_notify_state WHERE id = 1`);
		if (rows.length) return rows[0];
		await pool.execute(`INSERT INTO ai_notify_state (id) VALUES (1)`);
		return { id: 1, last_digest_at: null, last_digest_checksum: null, last_urgent_at: null, last_urgent_checksum: null };
	}

	async updateNotifyState(fields) {
		const pool = getPool();
		const state = await this.getNotifyState();
		const next = { ...state, ...fields };
		await pool.execute(
			`REPLACE INTO ai_notify_state (id, last_digest_at, last_digest_checksum, last_urgent_at, last_urgent_checksum) VALUES (1, ?, ?, ?, ?)`,
			[next.last_digest_at, next.last_digest_checksum, next.last_urgent_at, next.last_urgent_checksum]
		);
		return next;
	}

	async maybeSendDigest(tweets) {
		this.state.phase = 'digest_check';
		this.logEvent('digest_check');
		const text = this.formatTweetsForPrompt(tweets);
		const checksum = AIService.computeChecksum(text);
		const state = await this.getNotifyState();
		const last = state.last_digest_at ? new Date(state.last_digest_at).getTime() : 0;
		const due = Date.now() - last >= this.digestIntervalMs;
		if (!due && state.last_digest_checksum === checksum) return;

		// Always use cached opus insight if available
		const cached = await this.getCachedInsight(checksum, this.opusModel);
		let content = cached;
		if (!content) {
			const prompt = this.buildPrompt(text);
			content = await this.runModel(this.opusModel, this.opusMaxTokens, prompt);
			await this.saveInsight(checksum, this.opusModel, content);
		}
		if (global.notify) {
			let compact = { tickers: [], headline: '' };
			try { compact = await this.compactFromContent(content); } catch {}
			const tick = (compact.tickers || []).slice(0, 6).join(' ');
			const line = this.sanitizeForTelegram(`AI DIGEST: ${tick} — ${compact.headline}`);
			await global.notify([{ username: 'AI', id: checksum, text: line.slice(0, 400), created_at: new Date().toISOString(), url: 'AI://digest', isTest: false }]);
		}
		await this.updateNotifyState({ last_digest_at: new Date(), last_digest_checksum: checksum });
		this.state.lastDigestAt = new Date();
		this.logEvent('digest_sent', { checksum });
	}

	// Fast-path urgent alert using Haiku while Opus processes (with deduplication)
	async maybeSendHaikuFlash(tweets) {
		this.state.phase = 'haiku_flash_check';
		this.logEvent('haiku_check_start');
		const text = this.formatTweetsForPrompt(tweets);
		const checksum = AIService.computeChecksum(text);
		const { urgent } = await this.decideShouldRunOpus(tweets);
		this.state.lastHaikuDecisionAt = new Date();
		this.state.lastHaikuUrgent = urgent;
		if (!urgent) return;

		const state = await this.getNotifyState();
		const last = state.last_urgent_at ? new Date(state.last_urgent_at).getTime() : 0;

		// Enhanced cooldown: check both time and content similarity
		if (Date.now() - last < this.urgentCooldownMs) {
			this.logEvent('urgent_skipped_cooldown', { remainingMs: this.urgentCooldownMs - (Date.now() - last) });
			return;
		}

		// Check recent alerts for similarity (last hour)
		const alertsInLastHour = await this.getRecentAlerts(60 * 60 * 1000);
		if (alertsInLastHour.length >= this.maxAlertsPerHour) {
			this.logEvent('urgent_skipped_rate_limit', { alertsInLastHour: alertsInLastHour.length });
			return;
		}

		const prompt = `Write ONE urgent Telegram alert line (<= 180 chars). Start with URGENT:. Include 1-3 top $TICKERS. Focus on the new/time-sensitive change. No hashtags, no markdown.\n\n<tweets>\n${text}\n</tweets>`;
		let message = '';
		try { message = (await this.runModel(this.haikuModel, 256, prompt)).trim().replace(/\n+/g,' '); } catch {}
		if (!message) return;

		// Check if this message is too similar to recent alerts
		const similarity = await this.calculateMessageSimilarity(message, alertsInLastHour.map(a => a.message));
		if (similarity > this.alertSimilarityThreshold) {
			this.logEvent('urgent_skipped_similarity', { similarity, message: message.slice(0, 50) });
			return;
		}

		if (global.notify) {
			await global.notify([{ username: 'AI', id: checksum, text: message.slice(0, 180), created_at: new Date().toISOString(), url: 'AI://urgent', isTest: false }]);
		}
		// Also send to Discord webhook with tickers extracted
		try {
			const tickers = (message.match(/\$[A-Z]{2,10}/g) || []).slice(0, 6);
			if (global.notifyAI) {
				await global.notifyAI({ headline: message, tickers });
			}
		} catch {}
		// persist history + update state
		const pool = getPool();
		await pool.execute(`INSERT INTO ai_notify_history (message, urgency, summary_checksum) VALUES (?, ?, ?)`, [message.slice(0, 1000), 'URGENT', checksum]);
		await this.updateNotifyState({ last_urgent_at: new Date(), last_urgent_checksum: checksum });
		this.state.lastHaikuFlashAt = new Date();
		this.state.lastUrgentAt = this.state.lastHaikuFlashAt;
		this.logEvent('urgent_flash_sent', { checksum, message });
	}

	async getStatus() {
		const notifyState = await this.getNotifyState();
		const latest = await this.getLatestInsightRow();

		// recent history count (24h) - gracefully handle missing table
		let recentAlerts24h = 0;
		try {
			const pool = getPool();
			const [cnt] = await pool.execute(`SELECT COUNT(*) as c FROM ai_notify_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
			recentAlerts24h = (cnt && cnt[0] && cnt[0].c) || 0;
		} catch (error) {
			if (!error.message.includes("doesn't exist")) {
				console.error('❌ Error getting recent alerts count:', error.message);
			}
		}

		const now = Date.now();
		const lastDigestMs = notifyState.last_digest_at ? new Date(notifyState.last_digest_at).getTime() : 0;
		const nextDigestMs = Math.max(0, (lastDigestMs ? lastDigestMs + this.digestIntervalMs : 0) - now);
		const lastUrgentMs = notifyState.last_urgent_at ? new Date(notifyState.last_urgent_at).getTime() : 0;
		const urgentCooldownRemainingMs = Math.max(0, (lastUrgentMs ? lastUrgentMs + this.urgentCooldownMs : 0) - now);
		const enabled = Boolean(process.env.ANTHROPIC_API_KEY);
		let idleReason = '';
		if (!enabled) idleReason = 'disabled (no API key)';
		else if (!this.state.running) {
			if (nextDigestMs > 0) idleReason = `waiting digest ${Math.ceil(nextDigestMs/60000)}m`;
			else idleReason = 'waiting new tweet change';
		}
		return {
			phase: this.state.phase,
			running: this.state.running,
			lastInsightAt: latest?.created_at || this.state.lastInsightAt,
			lastOpusAt: this.state.lastOpusAt,
			lastDigestAt: notifyState.last_digest_at || this.state.lastDigestAt,
			lastUrgentAt: notifyState.last_urgent_at || this.state.lastUrgentAt,
			lastHaikuFlashAt: this.state.lastHaikuFlashAt,
			lastSonnetAt: this.state.lastSonnetAt,
			lastHaikuDecisionAt: this.state.lastHaikuDecisionAt,
			recentAlerts24h,
			enabled,
			nextDigestMs,
			urgentCooldownRemainingMs,
			lastHaikuUrgent: this.state.lastHaikuUrgent,
			lastHaikuChange: this.state.lastHaikuChange,
			idleReason
		};
	}

	// Sonnet-based TG notification decider with message history context
	async decideTelegramNotify(opusContent) {
		const pool = getPool();
		const checksum = AIService.computeChecksum(opusContent);
		const [historyRows] = await pool.execute(
			`SELECT message FROM ai_notify_history ORDER BY created_at DESC LIMIT 20`
		);
		const history = historyRows.map(r => r.message).join('\n---\n');
		const prompt = `You are a notification decider for crypto market alerts. Consider the current market summary and the last alerts you sent. Decide whether to send an alert now.\n\nReturn STRICT JSON with keys: {\n  \"send\": boolean,\n  \"urgency\": \"URGENT\"|\"DIGEST\"|\"RESEARCH\",\n  \"reason\": string,\n  \"message\": string\n}\n\nRules:\n- Send URGENT only for new, time-sensitive, high-impact changes (new tickers or major narrative shift).\n- Avoid repeats; if similar to recent alerts, set send=false and explain.\n- Message must include 1-3 top $TICKERS when relevant and be under 200 chars.\n- If change is notable but not urgent, use DIGEST.\n\n<alerts_history>\n${history}\n</alerts_history>\n\n<current_summary>\n${opusContent}\n</current_summary>`;
		const out = await this.runModel(this.sonnetModel, 1024, prompt, { purpose: 'alert_decider', responseFormat: 'json_object' });
		return { checksum, out };
	}

	async maybeTelegramNotifyFromSummary(opusContent) {
		if (!opusContent) return;
		const { checksum, out } = await this.decideTelegramNotify(opusContent);
		let decision;
		try { decision = JSON.parse(out); } catch { decision = null; }
		if (!decision || typeof decision.send !== 'boolean') return;
		if (!decision.send) {
			this.logEvent('thinking_decision_skip', { checksum, reason: decision.reason || 'no_reason' });
			return;
		}
		const urgency = (decision.urgency || 'DIGEST').toUpperCase().slice(0, 16);
		const messageRaw = String(decision.message || '').slice(0, 500);
		const message = this.sanitizeForTelegram(messageRaw);
		if (!message) return;
		if (global.notify) {
			await global.notify([{ username: 'AI', id: checksum, text: message, created_at: new Date().toISOString(), url: 'AI://tg', isTest: false }]);
		}
		// Also push to Discord AI channel if available
		try {
			const tickers = (message.match(/\$[A-Z]{2,10}/g) || []).slice(0, 6);
			if (global.notifyAI) await global.notifyAI({ headline: message, tickers });
		} catch {}
		const pool = getPool();
		await pool.execute(`INSERT INTO ai_notify_history (message, urgency, summary_checksum) VALUES (?, ?, ?)`, [message, urgency, checksum]);
		this.state.lastSonnetAt = new Date();
		this.logEvent('sonnet_notification_sent', { checksum, urgency, message });
	}

	async compactFromContent(content) {
		if (!content) return { tickers: [], headline: '' };

		const prompt = `Extract the most important tickers and create a one-line headline from this crypto analysis. Return JSON only:

<analysis>
${content}
</analysis>

Return JSON with:
- "tickers": array of 3-6 most important $TICKER symbols mentioned
- "headline": one concise sentence (max 100 chars) summarizing the key insight

Focus on actionable information and trending narratives. Example:
{"tickers": ["$BTC", "$ETH", "$SOL"], "headline": "DeFi yields surge as institutional adoption accelerates"}`;

		try {
			const response = await this.runModel(this.haikuModel, 1024, prompt);
			const parsed = JSON.parse(response.trim());
			return {
				tickers: Array.isArray(parsed.tickers) ? parsed.tickers.slice(0, 6) : [],
				headline: typeof parsed.headline === 'string' ? parsed.headline.slice(0, 150) : ''
			};
		} catch (error) {
			// Fallback to regex extraction
			const tickerSet = new Set((content.match(/\$[A-Z]{2,10}/g) || []).slice(0, 6));
			const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
			let headline = '';

			const hotIdx = lines.findIndex(l => l.toLowerCase().startsWith('**hot now') || l.toLowerCase().startsWith('hot now'));
			if (hotIdx !== -1) {
				headline = lines[hotIdx + 1] || lines[hotIdx];
			}

			if (!headline) {
				const aiPick = lines.find(l => /ai pick/i.test(l));
				headline = aiPick || lines.find(l => l.length > 20 && l.length < 120) || 'Market analysis updated';
			}

			return {
				tickers: Array.from(tickerSet),
				headline: headline.replace(/\*\*/g, '').slice(0, 100)
			};
		}
	}

	/**
	 * Get recent alerts from history for deduplication
	 */
	async getRecentAlerts(timeWindowMs) {
		try {
			const pool = getPool();
			const [rows] = await pool.execute(
				`SELECT message, created_at FROM ai_notify_history
				 WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MICROSECOND)
				 AND urgency = 'URGENT'
				 ORDER BY created_at DESC`,
				[timeWindowMs * 1000]
			);
			return rows || [];
		} catch (error) {
			// Gracefully handle missing table
			return [];
		}
	}

	/**
	 * Calculate similarity between message and recent messages
	 */
	async calculateMessageSimilarity(newMessage, recentMessages) {
		if (!recentMessages || recentMessages.length === 0) return 0;

		const normalize = (text) => text.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		const newNorm = normalize(newMessage);
		let maxSimilarity = 0;

		for (const recent of recentMessages) {
			const recentNorm = normalize(recent);

			// Simple Jaccard similarity on words
			const newWords = new Set(newNorm.split(' '));
			const recentWords = new Set(recentNorm.split(' '));

			const intersection = new Set([...newWords].filter(x => recentWords.has(x)));
			const union = new Set([...newWords, ...recentWords]);

			const similarity = intersection.size / union.size;
			maxSimilarity = Math.max(maxSimilarity, similarity);

			// Also check for ticker overlap
			const newTickers = newMessage.match(/\$[A-Z]{2,10}/g) || [];
			const recentTickers = recent.match(/\$[A-Z]{2,10}/g) || [];

			if (newTickers.length > 0 && recentTickers.length > 0) {
				const tickerOverlap = newTickers.filter(t => recentTickers.includes(t)).length;
				const tickerSimilarity = tickerOverlap / Math.max(newTickers.length, recentTickers.length);

				// If high ticker overlap and similar structure, boost similarity
				if (tickerSimilarity > 0.5 && similarity > 0.3) {
					maxSimilarity = Math.max(maxSimilarity, 0.85);
				}
			}
		}

		return maxSimilarity;
	}

	getLogs() { return this.logs; }
}

module.exports = AIService;
