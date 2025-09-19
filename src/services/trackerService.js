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
		this.DEFAULT_ACCOUNTS = ['cz_binance', 'CookerFlips', 'ShockedJS', 'LabsNoor', '0xpeely', 'km_trades', 'astaso1', 'eyearea', 'trading_axe', 'OwariETH', 'issathecooker', 'mmissoralways'];
        this.TEST_ACCOUNTS = ['alien88ted'];
		this.dynamicAccounts = new Set(); // from DB tracked_accounts
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

			// Get accounts from environment or use defaults + dynamic from DB
			const accountsEnv = process.env.TWITTER_ACCOUNTS || this.DEFAULT_ACCOUNTS.join(',');
			let accounts = accountsEnv.split(',').map(a => a.trim()).filter(a => a);
			// merge dynamic
			try {
				const pool = getPool();
				const [rows] = await pool.execute('SELECT username FROM tracked_accounts');
				rows.forEach(r => this.dynamicAccounts.add(r.username));
				accounts = Array.from(new Set([...accounts, ...Array.from(this.dynamicAccounts)]));
			} catch {}

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
			const usernames = [...this.DEFAULT_ACCOUNTS, ...this.TEST_ACCOUNTS, ...Array.from(this.dynamicAccounts)];
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
								url: `https://twitter.com/${username}/status/${t.id}`,
								tweetType: 'live' // Mark as live tweets from sync
							}));
							// Emit both events for compatibility
							global.io.emit('newTweets', processedTweets); // Backward compatibility
							global.io.emit('liveTweets', processedTweets); // Enhanced UX
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
     * Initialize one-time backfill system (last 100 tweets only)
     */
    async initializeBackfillSystem(accounts) {
        this.backfillState = {
            currentAccount: 0,
            totalTweetsBackfilled: 0,
            lastBackfillTime: Date.now(),
            accountProgress: []
        };

        // Check which accounts need initial 100-tweet backfill
        for (const username of accounts) {
            const tweetCount = await this.twitterService.getTweetCount(username);
            const needsBackfill = tweetCount === 0; // Only backfill if no tweets exist
            
            this.backfillState.accountProgress.push({
                username,
                lastBackfillId: null,
                completed: !needsBackfill, // Mark as completed if no backfill needed
                isInitialBackfill: needsBackfill
            });
            
            if (needsBackfill) {
                console.log(`🆕 @${username} needs initial 100-tweet backfill`);
            } else {
                console.log(`✅ @${username} already initialized (${tweetCount} tweets) - no backfill needed`);
            }
        }

        console.log('🧠 One-time backfill system initialized');

        // Start one-time backfill after initial setup (wait 10s)
        setTimeout(() => {
            this.runOneTimeBackfill();
        }, 10000);
    }

    /**
     * Run one-time backfill (last 100 tweets only per account)
     */
    async runOneTimeBackfill() {
        if (!this.isRunning) return;

        console.log('🚀 Starting one-time initialization backfill (100 tweets per new account)');

        for (const accountInfo of this.backfillState.accountProgress) {
            if (!accountInfo.isInitialBackfill || accountInfo.completed) {
                continue; // Skip accounts that don't need backfill
            }

            try {
                console.log(`📥 Initial backfill for @${accountInfo.username} (last 100 tweets)...`);

                // Get last 100 tweets for this account (no until_id = gets most recent)
                const tweets = await this.twitterService.fetchLatestTweets(
                    accountInfo.username, 
                    false, // not prioritizing new (this is backfill)
                    null   // no maxId = gets most recent 100 tweets
                );

                if (tweets.length > 0) {
                    // Save tweets to database
                    let savedCount = 0;
                    const historicalTweets = [];
                    
                    for (const tweet of tweets) {
                        try {
                            await this.twitterService.saveTweetsToDb([tweet], accountInfo.username);
                            savedCount++;
                            
                            // Prepare for historical emission (background)
                            historicalTweets.push({
                                ...tweet,
                                username: accountInfo.username,
                                isTest: this.TEST_ACCOUNTS.includes(accountInfo.username),
                                url: `https://twitter.com/${accountInfo.username}/status/${tweet.id}`,
                                tweetType: 'historical' // Mark as historical backfill
                            });
                        } catch (error) {
                            if (!error.message.includes('Duplicate entry')) {
                                console.error(`❌ Error saving tweet ${tweet.id}:`, error.message);
                            }
                        }
                    }

                    // Emit historical tweets in background (non-disruptive)
                    if (global.io && historicalTweets.length > 0) {
                        global.io.emit('historicalTweets', historicalTweets);
                    }

                    this.backfillState.totalTweetsBackfilled += savedCount;
                    console.log(`✅ @${accountInfo.username}: Saved ${savedCount}/${tweets.length} tweets`);
                } else {
                    console.log(`⚠️  @${accountInfo.username}: No tweets found`);
                }

                // Mark as completed (never backfill again)
                accountInfo.completed = true;
                
                // Brief delay between accounts
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`❌ Initial backfill error @${accountInfo.username}:`, error.message);
                // Mark as completed even on error to avoid infinite retries
                accountInfo.completed = true;
            }
        }

        console.log(`🎉 One-time backfill complete! Total tweets: ${this.backfillState.totalTweetsBackfilled}`);
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
		const usernames = [...this.DEFAULT_ACCOUNTS, ...this.TEST_ACCOUNTS, ...Array.from(this.dynamicAccounts)];
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
            isTest: this.TEST_ACCOUNTS.includes(row.username),
            tweetType: 'fresh' // Mark as fresh load from DB
        }));
    }
}

module.exports = TrackerService;
