const TwitterService = require('./twitterService');
const { initializeDB, getPool } = require('../config/database');

class TrackerService {
    constructor() {
        this.twitterService = new TwitterService();
        this.isRunning = false;
        this.backfillState = null;
        
        // DB-first sync helpers
        this.accountSync = new Map(); // username -> lastSyncMs
        this.minSyncIntervalMs = 45000; // cooldown per account
        this.syncPromise = null; // share in-flight sync among callers
        
		// Default accounts configuration
		this.DEFAULT_ACCOUNTS = ['cz_binance', 'CookerFlips', 'ShockedJS', 'LabsNoor'];
        this.TEST_ACCOUNTS = ['alien88ted'];
    }

    /**
     * Start the multi-account Twitter tracker
     */
    async start() {
        if (this.isRunning) {
            console.log('⚠️  Tracker is already running');
            return;
        }

        console.log('🚀 Starting REAL-TIME Alpha Tracker...');
        
        try {
            // Initialize database
            await initializeDB();
            
            // Load API usage from database
            await this.twitterService.loadApiUsage();

            // Get accounts from environment or use defaults
            const accountsEnv = process.env.TWITTER_ACCOUNTS || this.DEFAULT_ACCOUNTS.join(',');
            const accounts = accountsEnv.split(',').map(a => a.trim()).filter(a => a);

            console.log(`📊 Alpha accounts: ${accounts.join(', ')}`);
            console.log(`🧪 Test accounts: ${this.TEST_ACCOUNTS.join(', ')} [FEED ONLY]`);
        console.log('🔴 LIVE STREAM MODE - Zero polling delay!');

        this.isRunning = true;

        // IMMEDIATELY sync fresh 24h tweets to DB for instant display without redundant API
        console.log('🚀 STARTUP: Syncing fresh 24h tweets to DB...');
        try {
            await this.syncLatestTweets(24);
            console.log('⚡ STARTUP SYNC COMPLETE: DB up-to-date for last 24h');
        } catch (error) {
            console.error('❌ Error syncing startup tweets:', error.message);
        }

		// Try to setup real-time streaming first
		const stream = await this.twitterService.setupRealTimeStream(accounts, this.TEST_ACCOUNTS);

            if (!stream) {
				console.log('📡 Stream failed, setting up polling fallback...');
				await this.setupPollingFallback([...accounts, ...this.TEST_ACCOUNTS]);
            } else {
                console.log('✅ Real-time streaming active');
            }

			// Optional backfill (disabled by default to focus on new tweets)
			if (process.env.BACKFILL_ENABLED === 'true') {
				await this.initializeBackfillSystem(accounts);
			}
            
            console.log('✅ Alpha Tracker is now LIVE!');

        } catch (error) {
            console.error('❌ Failed to start tracker:', error.message);
            this.isRunning = false;
            throw error;
        }
    }

    /**
     * Sync latest tweets into DB for the past N hours without re-fetching known tweets.
     * Uses since_id and per-account cooldown; safe to call repeatedly.
     */
	async syncLatestTweets(hours = 24) {
        if (this.syncPromise) return this.syncPromise;

        this.syncPromise = (async () => {
			const usernames = [...this.DEFAULT_ACCOUNTS, ...this.TEST_ACCOUNTS];
            for (const username of usernames) {
                const lastSync = this.accountSync.get(username) || 0;
                if (Date.now() - lastSync < this.minSyncIntervalMs) {
                    continue; // cooldown
                }

                try {
                    const newTweets = await this.twitterService.fetchLatestTweets(username, true);
                    if (newTweets.length > 0) {
                        await this.twitterService.saveTweetsToDb(newTweets, username);
						// Emit and notify immediately for zero-latency UX
						if (global.io) {
							const processedTweets = newTweets.map(t => ({
								...t,
								username,
								isTest: this.TEST_ACCOUNTS.includes(username),
								url: `https://twitter.com/${username}/status/${t.id}`
							}));
							global.io.emit('newTweets', processedTweets);
						}
						if (global.aiMaybeUpdate) {
							global.aiMaybeUpdate();
						}
						if (global.notify) {
							await global.notify(newTweets.map(t => ({
								...t,
								username,
								isTest: this.TEST_ACCOUNTS.includes(username),
								url: `https://twitter.com/${username}/status/${t.id}`
							})));
						}
                        console.log(`📥 Synced @${username}: +${newTweets.length} new tweets`);
                    }
                    this.accountSync.set(username, Date.now());
                    await new Promise(resolve => setTimeout(resolve, 120));
                } catch (error) {
                    console.error(`❌ Sync error @${username}:`, error.message);
                }
            }
        })().finally(() => { this.syncPromise = null; });

        return this.syncPromise;
    }

    /**
     * Setup polling fallback if streaming fails
     */
    async setupPollingFallback(accounts) {
		const fetchNewTweets = async () => {
            if (!this.isRunning) return;

            console.log('\n🔥 [POLLING] Scanning for new tweets...');

            for (const username of accounts) {
                try {
                    const newTweets = await this.twitterService.fetchLatestTweets(username, true);
                    if (newTweets.length > 0) {
                        console.log(`🚨 NEW ALPHA @${username}: ${newTweets.length} fresh tweets!`);
                        await this.twitterService.saveTweetsToDb(newTweets, username);
                        
                        // Emit to connected clients
                        const io = require('../server').io;
                        if (io) {
                            const processedTweets = newTweets.map(tweet => ({
                                ...tweet,
                                username: username,
                                isTest: false,
                                url: `https://twitter.com/${username}/status/${tweet.id}`
                            }));
                            io.emit('newTweets', processedTweets);
                        }
                    }

                    // Check API limits and pause if needed
                    const usage = this.twitterService.getApiUsage();
                    if (usage.usagePercentage > 90) {
                        console.log('🚨 API limit approaching, brief pause...');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } catch (error) {
                    console.error(`❌ Error fetching new tweets @${username}:`, error.message);
                }
            }
        };

		// Start with initial fetch
		await fetchNewTweets();

			// Higher frequency fallback polling focused on fresh tweets
			console.log('⚡ Fallback polling: every 15 seconds (fresh only)');
			this.pollingInterval = setInterval(fetchNewTweets, 15000);
    }

    /**
     * Initialize smart backfill system
     */
    async initializeBackfillSystem(accounts) {
        this.backfillState = {
            currentAccount: 0,
            totalTweetsBackfilled: 0,
            lastBackfillTime: Date.now(),
            accountProgress: []
        };

        // Initialize account progress with oldest tweet IDs
        for (const username of accounts) {
            const oldestId = await this.twitterService.getOldestTweetId(username);
            this.backfillState.accountProgress.push({
                username,
                lastBackfillId: oldestId,
                completed: false
            });
            
            if (oldestId) {
                console.log(`🔄 @${username} backfill will start from tweet ID: ${oldestId}`);
            } else {
                console.log(`🆕 @${username} no existing tweets - fresh backfill`);
            }
        }

        console.log('🧠 Smart backfill system initialized');

        // Start backfill after initial setup (wait 30s)
        setTimeout(() => {
            this.runSmartBackfill().then(() => {
                this.scheduleNextBackfill();
            });
        }, 30000);
    }

    /**
     * Run smart backfill based on API usage
     */
    async runSmartBackfill() {
        if (!this.isRunning) return;

        const usage = this.twitterService.getApiUsage();
        const availableRequests = usage.rateLimit - usage.requests;
        const timeUntilReset = usage.timeUntilReset;

        // Dynamic thresholds based on time until reset
        let maxBackfillRequests;
        if (timeUntilReset > 10 * 60 * 1000) { // More than 10 min left
            maxBackfillRequests = Math.min(50, availableRequests * 0.3);
        } else if (timeUntilReset > 5 * 60 * 1000) { // More than 5 min left
            maxBackfillRequests = Math.min(20, availableRequests * 0.2);
        } else { // Less than 5 min left
            maxBackfillRequests = Math.min(5, availableRequests * 0.1);
        }

        console.log(`📊 Backfill budget: ${maxBackfillRequests} requests (${availableRequests} available, ${Math.floor(timeUntilReset/60000)}min until reset)`);

        if (maxBackfillRequests < 5) {
            console.log('⏸️  Pausing backfill - insufficient API budget');
            return;
        }

        let requestsUsed = 0;
        const startAccount = this.backfillState.currentAccount;

        // Cycle through accounts
        while (requestsUsed < maxBackfillRequests && this.isRunning) {
            const accountInfo = this.backfillState.accountProgress[this.backfillState.currentAccount];

            if (accountInfo.completed) {
                console.log(`✅ @${accountInfo.username} backfill completed, moving to next`);
                this.backfillState.currentAccount = (this.backfillState.currentAccount + 1) % this.backfillState.accountProgress.length;

                // If we've cycled through all accounts, reset
                if (this.backfillState.currentAccount === startAccount) {
                    console.log('🔄 All accounts backfilled, resetting for next cycle');
                    this.backfillState.accountProgress.forEach(acc => acc.completed = false);
                    break;
                }
                continue;
            }

            try {
                console.log(`📥 Backfilling @${accountInfo.username}...`);

                // Get older tweets using the last ID we processed
                const oldTweets = await this.twitterService.fetchLatestTweets(
                    accountInfo.username, 
                    false, 
                    accountInfo.lastBackfillId
                );
                requestsUsed += 2; // userTimeline + getUserId

                if (oldTweets.length > 0) {
                    // Save tweets and count new ones
                    let newTweets = 0;
                    for (const tweet of oldTweets) {
                        try {
                            await this.twitterService.saveTweetsToDb([tweet], accountInfo.username);
                            newTweets++;
                        } catch (error) {
                            if (!error.message.includes('Duplicate entry')) {
                                console.error(`❌ Error saving tweet ${tweet.id}:`, error.message);
                            }
                        }
                    }

                    this.backfillState.totalTweetsBackfilled += newTweets;
                    accountInfo.lastBackfillId = oldTweets[oldTweets.length - 1].id;

                    console.log(`📦 @${accountInfo.username}: +${newTweets}/${oldTweets.length} new tweets (${this.backfillState.totalTweetsBackfilled} total)`);
                } else {
                    // No more tweets to backfill for this account
                    accountInfo.completed = true;
                    console.log(`✅ @${accountInfo.username} backfill completed (no more tweets)`);
                }

            } catch (error) {
                console.error(`❌ Backfill error @${accountInfo.username}:`, error.message);
                requestsUsed++; // Count failed requests too
            }

            // Move to next account
            this.backfillState.currentAccount = (this.backfillState.currentAccount + 1) % this.backfillState.accountProgress.length;

            // Small delay between accounts
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        this.backfillState.lastBackfillTime = Date.now();
        console.log(`📈 Backfill session complete: used ${requestsUsed}/${maxBackfillRequests} requests`);
    }

    /**
     * Schedule next backfill based on API usage
     */
    scheduleNextBackfill() {
        if (!this.isRunning) return;

        const usage = this.twitterService.getApiUsage();
        const currentUsage = usage.usagePercentage / 100;
        let intervalMs;

        if (currentUsage < 0.3) {
            intervalMs = 2 * 60 * 1000; // 2 minutes when usage is low
        } else if (currentUsage < 0.6) {
            intervalMs = 5 * 60 * 1000; // 5 minutes when usage is medium
        } else if (currentUsage < 0.8) {
            intervalMs = 10 * 60 * 1000; // 10 minutes when usage is high
        } else {
            intervalMs = 20 * 60 * 1000; // 20 minutes when usage is very high
        }

        console.log(`⏰ Next backfill in ${Math.floor(intervalMs/60000)} minutes (usage: ${Math.floor(currentUsage*100)}%)`);
        
        this.backfillTimeout = setTimeout(() => {
            if (this.isRunning) {
                this.runSmartBackfill().then(() => {
                    this.scheduleNextBackfill();
                });
            }
        }, intervalMs);
    }

    /**
     * Stop the tracker
     */
    stop() {
        if (!this.isRunning) {
            console.log('⚠️  Tracker is not running');
            return;
        }

        console.log('🛑 Stopping Alpha Tracker...');
        this.isRunning = false;

        // Close stream
        this.twitterService.closeStream();

        // Clear intervals and timeouts
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        if (this.backfillTimeout) {
            clearTimeout(this.backfillTimeout);
        }

        console.log('✅ Alpha Tracker stopped');
    }

    /**
     * Get tracker status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            apiUsage: this.twitterService.getApiUsage(),
            backfillState: this.backfillState,
            accounts: {
                production: this.DEFAULT_ACCOUNTS,
                test: this.TEST_ACCOUNTS
            }
        };
    }

    /**
     * Serve fresh tweets from DB for last 24h; performs quick sync-only-new beforehand.
     */
    async getFreshTweets() {
        await this.syncLatestTweets(24);

        const pool = getPool();
		const usernames = [...this.DEFAULT_ACCOUNTS, ...this.TEST_ACCOUNTS];
        const placeholders = usernames.map(() => '?').join(',');
        const params = [...usernames];
        const limit = 200;

		const [rows] = await pool.execute(
            `SELECT *
             FROM cz_tweets
			 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
			   AND username IN (${placeholders})
             ORDER BY created_at DESC
             LIMIT ${limit}`,
            params
        );

        console.log(`✅ Served ${rows.length} tweets from DB (24h window)`);
        return rows.map(row => ({
            ...row,
            isTest: this.TEST_ACCOUNTS.includes(row.username)
        }));
    }
}

module.exports = TrackerService;
