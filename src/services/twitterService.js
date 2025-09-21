const { TwitterApi, ETwitterStreamEvent } = require('twitter-api-v2');
const { getPool } = require('../config/database');
const RateLimitManager = require('./rateLimitManager');
const TweetCache = require('./tweetCache');
const { ALLOWED_USERNAMES } = require('../config/allowlist');
require('dotenv').config();

class TwitterService {
    constructor() {
        this.client = null;
        this.readOnlyClient = null;
        this.stream = null;
        
        // Window and rate defaults (used for legacy usage tracking/UI only)
        this.WINDOW_MS = 15 * 60 * 1000; // 15 minutes
        this.RATE_LIMIT =  (typeof this?.rateLimitManager?.limits?.userTimeline?.requests === 'number')
            ? this.rateLimitManager.limits.userTimeline.requests
            : 300;
        
        // Simple in-memory cache for username -> userId to reduce lookups
        this.userCache = new Map();
        this.USER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
        
        // Initialize smart rate limit manager
        this.rateLimitManager = new RateLimitManager();
        
        // Initialize smart tweet cache for Pro plan optimization
        this.tweetCache = new TweetCache();
        
        // Legacy API usage tracking (kept for backwards compatibility)
        this.apiUsage = {
            requests: 0,
            windowStart: Date.now(),
            dailyRequests: 0,
            dailyStart: new Date().toDateString()
        };
        
        this.initialize();
    }

    /**
     * Initialize Twitter API client with Bearer Token authentication
     */
    initialize() {
        if (!process.env.TWITTER_BEARER_TOKEN) {
            throw new Error('TWITTER_BEARER_TOKEN is required in environment variables');
        }

        try {
            // Create client with Bearer Token (App-only authentication)
            this.client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
            this.readOnlyClient = this.client.readOnly;
            
            console.log('✅ Twitter API client initialized with Bearer Token');
        } catch (error) {
            console.error('❌ Failed to initialize Twitter API client:', error.message);
            throw error;
        }
    }

    /**
     * Load API usage from database on startup
     */
    async loadApiUsage() {
        const pool = getPool();
        const now = Date.now();
        const today = new Date().toISOString().split('T')[0];

        try {
            // Get current window usage
            const windowStart = Math.floor(now / this.WINDOW_MS) * this.WINDOW_MS;
            const [windowRows] = await pool.execute(
                'SELECT requests_count FROM api_usage WHERE window_start = ?',
                [windowStart]
            );

            // Get daily usage
            const [dailyRows] = await pool.execute(
                'SELECT daily_requests FROM api_usage WHERE daily_date = ?',
                [today]
            );

            this.apiUsage.requests = windowRows.length > 0 ? windowRows[0].requests_count : 0;
            this.apiUsage.windowStart = windowStart;
            this.apiUsage.dailyRequests = dailyRows.length > 0 ? dailyRows[0].daily_requests : 0;
            this.apiUsage.dailyStart = new Date().toDateString();

            console.log(`📊 API Usage loaded: ${this.apiUsage.requests}/${this.RATE_LIMIT} (${Math.floor(this.WINDOW_MS/60000)}min) | ${this.apiUsage.dailyRequests} today`);
        } catch (error) {
            console.error('❌ Error loading API usage:', error.message);
        }
    }

    /**
     * Save API usage to database
     */
    async saveApiUsage() {
        const pool = getPool();
        const today = new Date().toISOString().split('T')[0];

        try {
            // Save/update usage data
            await pool.execute(
                `INSERT INTO api_usage (window_start, requests_count, daily_date, daily_requests)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                 requests_count = VALUES(requests_count),
                 daily_requests = VALUES(daily_requests)`,
                [this.apiUsage.windowStart, this.apiUsage.requests, today, this.apiUsage.dailyRequests]
            );
        } catch (error) {
            console.error('❌ Error saving API usage:', error.message);
        }
    }

    /**
     * Track API usage with proper rate limiting
     */
    async trackApiCall() {
        const now = Date.now();
        const today = new Date().toDateString();

        // Reset daily counter if new day
        if (this.apiUsage.dailyStart !== today) {
            this.apiUsage.dailyRequests = 0;
            this.apiUsage.dailyStart = today;
        }

        // Reset window counter if new window
        if (now - this.apiUsage.windowStart > this.WINDOW_MS) {
            this.apiUsage.requests = 0;
            this.apiUsage.windowStart = Math.floor(now / this.WINDOW_MS) * this.WINDOW_MS;
        }

        this.apiUsage.requests++;
        this.apiUsage.dailyRequests++;

        console.log(`📊 API Usage: ${this.apiUsage.requests}/${this.RATE_LIMIT} (${Math.floor(this.WINDOW_MS/60000)}min) | ${this.apiUsage.dailyRequests} today`);

        // Save to database every 10 requests or when approaching limits
        if (this.apiUsage.requests % 10 === 0 || this.apiUsage.requests > this.RATE_LIMIT * 0.8) {
            await this.saveApiUsage();
        }

        // Alert if approaching limits
        if (this.apiUsage.requests > this.RATE_LIMIT * 0.8) {
            console.warn(`⚠️  Approaching rate limit: ${this.apiUsage.requests}/${this.RATE_LIMIT}`);
        }

        // Check if we should pause to avoid hitting limits
        if (this.apiUsage.requests >= this.RATE_LIMIT * 0.95) {
            const waitTime = this.WINDOW_MS - (now - this.apiUsage.windowStart);
            console.warn(`🚨 Rate limit nearly reached. Waiting ${Math.ceil(waitTime/1000)}s before next request`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    /**
     * Get user ID by username using Twitter API v2 with smart rate limiting
     */
    async getUserId(username) {
        try {
            // Serve from cache when possible
            const cached = this.userCache.get(username);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.id;
            }
            // Use rate limit manager to queue and control the request
            const result = await this.rateLimitManager.queueRequest(
                async () => {
                    const response = await this.readOnlyClient.v2.userByUsername(username);
                    return { data: response, headers: response._headers };
                },
                'userLookup',
                1, // High priority
                username
            );
            
            if (!result.data.data) {
                console.error(`❌ User @${username} not found`);
                return null;
            }
            
            const userId = result.data.data.id;
            // Update cache
            this.userCache.set(username, { id: userId, expiresAt: Date.now() + this.USER_CACHE_TTL_MS });
            console.log(`✅ Got user ID for @${username}: ${userId}`);
            return userId;
        } catch (error) {
            console.error(`❌ Error fetching user ID for @${username}:`, error.message);
            if (error.data) {
                console.error('Twitter API Error:', JSON.stringify(error.data, null, 2));
            }
            return null;
        }
    }

    /**
     * Fetch latest tweets with SMART CACHING for Pro plan optimization
     */
    async fetchLatestTweets(username, prioritizeNew = true, maxId = null) {
        try {
            // For fresh tweets, check cache first (PRO PLAN OPTIMIZATION)
            if (prioritizeNew && !maxId) {
                const cachedTweets = this.tweetCache.getCachedTweets(username);
                if (cachedTweets) {
                    return cachedTweets; // INSTANT RETURN - NO API CALL NEEDED!
                }
            }

            // Optional: prioritize listed accounts but do not exclude others
            const userId = await this.getUserId(username);
            if (!userId) {
                console.error(`❌ Cannot fetch tweets: User @${username} not found`);
                return [];
            }

            // Prepare options for the request - PRO PLAN AGGRESSIVE
            let options = {
                max_results: prioritizeNew ? 100 : 10,
                'tweet.fields': ['created_at', 'public_metrics', 'author_id', 'conversation_id'],
                exclude: ['retweets']
            };

            // For new tweet focus, add since_id to only get tweets newer than what we have
            if (prioritizeNew) {
                const latestId = await this.getLatestTweetId(username);
                if (latestId) {
                    options.since_id = latestId;
                }
            } else {
                // For backfill, use until_id to get older tweets
                if (maxId) {
                    options.until_id = maxId;
                }
            }

            // Use rate limit manager to queue and control the request
            const priority = prioritizeNew ? 3 : 1; // HIGHER priority for fresh tweets
            const result = await this.rateLimitManager.queueRequest(
                async () => {
                    console.log(`🚀 PRO PLAN: Making API call for @${username} (${prioritizeNew ? 'FRESH' : 'BACKFILL'})`);
                    const response = await this.readOnlyClient.v2.userTimeline(userId, options);
                    return { data: response, headers: response._headers };
                },
                'userTimeline',
                priority,
                username
            );

            const tweetsArray = [];
            for await (const tweet of result.data) {
                // Enrich with thread/reply hints if present in includes (future-proof)
                tweetsArray.push(tweet);
            }

            // Cache fresh tweets for future use (PRO PLAN OPTIMIZATION)
            if (prioritizeNew && tweetsArray.length > 0) {
                this.tweetCache.cacheTweets(username, tweetsArray);
            }

            const mode = prioritizeNew ? 'FRESH' : 'BACKFILL';
            console.log(`⚡ [${mode}] @${username}: ${tweetsArray.length} tweets fetched & cached`);
            return tweetsArray;

        } catch (error) {
            console.error(`❌ Error fetching tweets for @${username}:`, error.message);
            if (error.data) {
                console.error('Twitter API Error:', JSON.stringify(error.data, null, 2));
            }
            return [];
        }
    }

    /**
     * Setup real-time streaming using Twitter API v2 Filtered Stream
     */
    async setupRealTimeStream(accounts, testAccounts = []) {
        console.log('⚡ Setting up LIVE real-time stream with Twitter API v2...');

        try {
            // Get user IDs for all accounts
            const allAccounts = [...accounts, ...testAccounts];
            const userIds = [];
            const userMap = new Map();

            for (const username of allAccounts) {
                const userId = await this.getUserId(username);
                if (userId) {
                    userIds.push(userId);
                    userMap.set(userId, username);
                    const accountType = testAccounts.includes(username) ? '[TEST]' : '[PROD]';
                    console.log(`✅ ${accountType} Got ID for @${username}: ${userId}`);
                }
            }

            if (userIds.length === 0) {
                throw new Error('No valid user IDs found for streaming');
            }

            // Desired streaming rules for these specific users
            const desiredValues = new Set(userIds.map(userId => `from:${userId}`));

            // Reconcile rules (add missing, remove stale) to avoid 429s
            try {
                const currentRules = await this.readOnlyClient.v2.streamRules();
                const existing = new Map(); // value -> { id, tag }
                if (currentRules.data?.length) {
                    for (const r of currentRules.data) {
                        if (r.value) existing.set(r.value, { id: r.id, tag: r.tag });
                    }
                    if (global.aiMaybeUpdate) {
                        global.aiMaybeUpdate();
                    }
                }

                const toAdd = [];
                for (const value of desiredValues) {
                    if (!existing.has(value)) {
                        toAdd.push({ value, tag: `alpha_user_${value.split(':')[1]}` });
                    }
                }

                const toDeleteIds = [];
                for (const [value, meta] of existing.entries()) {
                    // Remove only our alpha_user_ rules that are no longer desired
                    if (meta.tag && meta.tag.startsWith('alpha_user_') && !desiredValues.has(value)) {
                        toDeleteIds.push(meta.id);
                    }
                }

                if (toDeleteIds.length > 0) {
                    await this.readOnlyClient.v2.updateStreamRules({ delete: { ids: toDeleteIds } });
                    console.log(`🧹 Deleted ${toDeleteIds.length} stale stream rules`);
                }
                if (toAdd.length > 0) {
                    await this.readOnlyClient.v2.updateStreamRules({ add: toAdd });
                    console.log(`📋 Added ${toAdd.length} streaming rules for tracked accounts`);
                } else {
                    console.log('✅ Stream rules already up-to-date');
                }
            } catch (error) {
                console.error('❌ Error reconciling stream rules:', error.message);
            }

            // Prepare the filtered stream (manual connect)
            this.stream = this.readOnlyClient.v2.searchStream({
                'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
                'user.fields': ['username'],
                expansions: ['author_id'],
                autoConnect: false
            });

            console.log('🔴 LIVE STREAM ACTIVE - Real-time alpha detection enabled!');

            // Handle incoming tweets
            this.stream.on(ETwitterStreamEvent.Data, async (tweet) => {
                try {
                    const authorId = tweet.data.author_id;
                    const username = userMap.get(authorId) || 'unknown';
                    const isTestAccount = testAccounts.includes(username);

                    // Emit first for near-zero latency, then notify & save in background
                    const payload = [{
                        ...tweet.data,
                        username,
                        isTest: isTestAccount,
                        url: `https://twitter.com/${username}/status/${tweet.data.id}`,
                        tweetType: 'realtime' // Mark as real-time stream tweet
                    }];

                    // Update in-memory cache for instant UI
                    try { this.tweetCache.addNewTweet(username, tweet.data); } catch {}

                    // Emit to connected clients via socket.io
                    const io = global.io;
                    if (io) {
                        // Emit both events for compatibility
                        io.emit('newTweets', payload); // Backward compatibility
                        io.emit('liveTweets', payload); // Enhanced UX - real-time priority
                    }

                    // Notify (Telegram) without blocking
                    if (global.notify) {
                        global.notify(payload).catch(() => {});
                    }

                    // Persist asynchronously (do not block live path)
                    this.saveTweetsToDb([tweet.data], username)
                        .then(() => {
                            console.log(`${isTestAccount ? '🧪 TEST FEED' : '🚨🔥 INSTANT ALPHA'} @${username}: "${tweet.data.text.substring(0, 100)}..."`);
                        })
                        .catch((e) => {
                            if (!String(e?.message || '').includes('Duplicate entry')) {
                                console.error('❌ Save error:', e?.message || e);
                            }
                        });
                } catch (error) {
                    console.error('❌ Error processing stream tweet:', error.message);
                }
            });

            // Handle stream events
            this.stream.on(ETwitterStreamEvent.Connected, () => {
                console.log('🟢 Stream connected - LIVE alpha detection active!');
            });

            this.stream.on(ETwitterStreamEvent.ConnectionError, (error) => {
                console.error('🔴 Stream connection error:', error.message);
            });

            this.stream.on(ETwitterStreamEvent.Error, (error) => {
                console.error('🔴 Stream error:', error.message);
                // Rely on autoReconnect to avoid re-adding rules and hitting 429
            });

            this.stream.on(ETwitterStreamEvent.ConnectionClosed, () => {
                console.log('🟡 Stream connection closed');
            });

            // Connect with aggressive auto-reconnect and shorter keepalive
            this.stream.keepAliveTimeoutMs = 30000;
            await this.stream.connect({ autoReconnect: true, autoReconnectRetries: Infinity });

            return this.stream;

        } catch (error) {
            console.error('❌ Failed to setup real-time stream:', error.message);
            if (error.data) {
                console.error('Twitter API Error:', JSON.stringify(error.data, null, 2));
            }
            return null;
        }
    }

    /**
     * Get latest tweet ID from database
     */
    async getLatestTweetId(username) {
        const pool = getPool();
        try {
            const [rows] = await pool.execute(
                'SELECT id FROM cz_tweets WHERE username = ? ORDER BY created_at DESC LIMIT 1',
                [username]
            );
            return rows.length > 0 ? rows[0].id : null;
        } catch (error) {
            console.error(`❌ Error getting latest tweet ID for @${username}:`, error.message);
            return null;
        }
    }

    /**
     * Get oldest tweet ID from database
     */
    async getOldestTweetId(username) {
        const pool = getPool();
        try {
            const [rows] = await pool.execute(
                'SELECT id FROM cz_tweets WHERE username = ? ORDER BY created_at ASC LIMIT 1',
                [username]
            );
            return rows.length > 0 ? rows[0].id : null;
        } catch (error) {
            console.error(`❌ Error getting oldest tweet ID for @${username}:`, error.message);
            return null;
        }
    }

    /**
     * Get tweet count for username from database
     */
    async getTweetCount(username) {
        const pool = getPool();
        try {
            const [rows] = await pool.execute(
                'SELECT COUNT(*) as count FROM cz_tweets WHERE username = ?',
                [username]
            );
            return rows.length > 0 ? rows[0].count : 0;
        } catch (error) {
            console.error(`❌ Error getting tweet count for @${username}:`, error.message);
            return 0;
        }
    }

    /**
     * Save tweets to database
     */
    async saveTweetsToDb(tweets, username) {
        const pool = getPool();
        if (!tweets || tweets.length === 0) {
            return;
        }

        // Batch insert to reduce DB calls
        const BATCH_SIZE = 25;
        for (let i = 0; i < tweets.length; i += BATCH_SIZE) {
            const batch = tweets.slice(i, i + BATCH_SIZE);
            const rows = batch.map(tweet => {
                const created = new Date(tweet.created_at);
                const createdMs = Number.isFinite(created.getTime()) ? created.getTime() : Number((BigInt(String(tweet.id)) >> 22n) + 1288834974657n);
                return [
                    tweet.id,
                    tweet.text,
                    created,
                    createdMs,
                    tweet.public_metrics?.retweet_count || 0,
                    tweet.public_metrics?.like_count || 0,
                    tweet.public_metrics?.reply_count || 0,
                    tweet.public_metrics?.quote_count || 0,
                    tweet.public_metrics?.impression_count || 0,
                    `https://twitter.com/${username}/status/${tweet.id}`,
                    username
                ];
            });

            const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const flatParams = rows.flat();

            try {
                await pool.execute(
                    `INSERT INTO cz_tweets
                    (id, text, created_at, created_at_ms, retweet_count, like_count, reply_count, quote_count, impression_count, url, username)
                    VALUES ${placeholders}
                    ON DUPLICATE KEY UPDATE
                    created_at = VALUES(created_at),
                    created_at_ms = VALUES(created_at_ms),
                    retweet_count = VALUES(retweet_count),
                    like_count = VALUES(like_count),
                    reply_count = VALUES(reply_count),
                    quote_count = VALUES(quote_count),
                    impression_count = VALUES(impression_count)`,
                    flatParams
                );
                console.log(`💾 Saved @${username} tweets: ${batch.length}`);
            } catch (error) {
                if (!String(error.message || '').includes('Duplicate entry')) {
                    console.error(`❌ Error saving tweet batch for @${username}:`, error.message);
                }
            }
        }
    }

    /**
     * Close stream connection
     */
    closeStream() {
        if (this.stream) {
            this.stream.close();
            console.log('🔴 Stream connection closed');
        }
    }

    /**
     * Get current API usage stats with smart rate limiting data
     */
    getApiUsage() {
        const rateLimitStatus = this.rateLimitManager.getRateLimitStatus();
        const timeUntilReset = this.WINDOW_MS - (Date.now() - this.apiUsage.windowStart);
        
        // Calculate overall usage across all endpoints
        let totalUsed = 0;
        let totalLimit = 0;
        let maxUsagePercentage = 0;
        
        Object.values(rateLimitStatus).forEach(status => {
            totalUsed += status.used;
            totalLimit += status.limit;
            maxUsagePercentage = Math.max(maxUsagePercentage, status.usagePercentage);
        });

        return {
            // Legacy format for backwards compatibility
            ...this.apiUsage,
            rateLimit: totalLimit || 300,
            windowMs: 15 * 60 * 1000,
            timeUntilReset,
            usagePercentage: maxUsagePercentage || Math.round((this.apiUsage.requests / 300) * 100),
            
            // New detailed rate limit data
            detailed: rateLimitStatus,
            summary: {
                totalUsed,
                totalLimit,
                maxUsagePercentage,
                plan: this.rateLimitManager.currentPlan,
                queueLength: this.rateLimitManager.requestQueue.length,
                isProcessingQueue: this.rateLimitManager.isProcessingQueue
            }
        };
    }
}

module.exports = TwitterService;
