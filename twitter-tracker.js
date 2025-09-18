const { TwitterApi, ETwitterStreamEvent } = require('twitter-api-v2');
const { initializeDB, pool } = require('./db');
require('dotenv').config();

const client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
const readOnlyClient = client.readOnly;

// API Usage Tracking
let apiUsage = {
    requests: 0,
    windowStart: Date.now(),
    dailyRequests: 0,
    dailyStart: new Date().toDateString()
};

// Pro Plan Limits: 900 requests per 15 minutes
const RATE_LIMIT = 900;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Load API usage from database on startup
async function loadApiUsage() {
    const connection = pool();
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];

    try {
        // Get current window usage
        const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
        const [windowRows] = await connection.execute(
            'SELECT requests_count FROM api_usage WHERE window_start = ?',
            [windowStart]
        );

        // Get daily usage
        const [dailyRows] = await connection.execute(
            'SELECT daily_requests FROM api_usage WHERE daily_date = ?',
            [today]
        );

        apiUsage.requests = windowRows.length > 0 ? windowRows[0].requests_count : 0;
        apiUsage.windowStart = windowStart;
        apiUsage.dailyRequests = dailyRows.length > 0 ? dailyRows[0].daily_requests : 0;
        apiUsage.dailyStart = new Date().toDateString();

        console.log(`📊 Loaded API usage: ${apiUsage.requests}/${RATE_LIMIT} (15min) | ${apiUsage.dailyRequests} today`);
    } catch (error) {
        console.error('Error loading API usage:', error);
    }
}

// Save API usage to database
async function saveApiUsage() {
    const connection = pool();
    const today = new Date().toISOString().split('T')[0];

    try {
        // Save window usage
        await connection.execute(
            `INSERT INTO api_usage (window_start, requests_count, daily_date, daily_requests)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE requests_count = VALUES(requests_count)`,
            [apiUsage.windowStart, apiUsage.requests, today, apiUsage.dailyRequests]
        );

        // Save daily usage
        await connection.execute(
            `INSERT INTO api_usage (window_start, requests_count, daily_date, daily_requests)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE daily_requests = VALUES(daily_requests)`,
            [0, 0, today, apiUsage.dailyRequests]
        );
    } catch (error) {
        console.error('Error saving API usage:', error);
    }
}

// Track API usage
async function trackApiCall() {
    const now = Date.now();
    const today = new Date().toDateString();

    // Reset daily counter if new day
    if (apiUsage.dailyStart !== today) {
        apiUsage.dailyRequests = 0;
        apiUsage.dailyStart = today;
    }

    // Reset window counter if new window
    if (now - apiUsage.windowStart > WINDOW_MS) {
        apiUsage.requests = 0;
        apiUsage.windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    }

    apiUsage.requests++;
    apiUsage.dailyRequests++;

    console.log(`API Usage: ${apiUsage.requests}/${RATE_LIMIT} (15min) | ${apiUsage.dailyRequests} today`);

    // Save to database every 10 requests or when approaching limits
    if (apiUsage.requests % 10 === 0 || apiUsage.requests > RATE_LIMIT * 0.8) {
        await saveApiUsage();
    }

    // Alert if approaching limits
    if (apiUsage.requests > RATE_LIMIT * 0.8) {
        console.warn(`⚠️  Approaching rate limit: ${apiUsage.requests}/${RATE_LIMIT}`);
    }
}

async function getUserId(username) {
    try {
        await trackApiCall();
        const user = await readOnlyClient.v2.userByUsername(username);
        return user.data.id;
    } catch (error) {
        console.error('Error fetching user ID:', error);
        return null;
    }
}

async function getLatestTweetId(username) {
    const connection = pool();
    try {
        const [rows] = await connection.execute(
            'SELECT id FROM cz_tweets WHERE username = ? ORDER BY created_at DESC LIMIT 1',
            [username]
        );
        return rows.length > 0 ? rows[0].id : null;
    } catch (error) {
        console.error(`Error getting latest tweet ID for @${username}:`, error);
        return null;
    }
}

async function getOldestTweetId(username) {
    const connection = pool();
    try {
        const [rows] = await connection.execute(
            'SELECT id FROM cz_tweets WHERE username = ? ORDER BY created_at ASC LIMIT 1',
            [username]
        );
        return rows.length > 0 ? rows[0].id : null;
    } catch (error) {
        console.error(`Error getting oldest tweet ID for @${username}:`, error);
        return null;
    }
}

async function fetchLatestTweets(username, prioritizeNew = true, maxId = null) {
    try {
        const userId = await getUserId(username);
        if (!userId) {
            console.error('User not found');
            return [];
        }

        await trackApiCall(); // Track the timeline request

        let options = {
            max_results: prioritizeNew ? 5 : 5, // Keep backfill small - just 5 tweets
            'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
            exclude: ['retweets', 'replies']
        };

        // For new tweet focus, add since_id to only get tweets newer than what we have
        if (prioritizeNew) {
            const latestId = await getLatestTweetId(username);
            if (latestId) {
                options.since_id = latestId;
            }
        } else {
            // For backfill, use max_id to get older tweets
            if (maxId) {
                options.max_results = 5; // Even smaller for backfill
                options.until_id = maxId; // Get tweets older than this ID
            }
        }

        const tweets = await readOnlyClient.v2.userTimeline(userId, options);

        const tweetsArray = [];
        for await (const tweet of tweets) {
            tweetsArray.push(tweet);
        }

        const mode = prioritizeNew ? 'NEW' : 'BACKFILL';
        console.log(`📡 [${mode}] @${username}: ${tweetsArray.length} tweets`);
        return tweetsArray;
    } catch (error) {
        console.error('Error fetching tweets:', error.message || error);
        if (error.data) {
            console.error('Twitter API Error:', JSON.stringify(error.data, null, 2));
        }
        return [];
    }
}

async function saveTweetsToDb(tweets, username = 'cz_binance') {
    const connection = pool();

    for (const tweet of tweets) {
        try {
            const tweetUrl = `https://twitter.com/${username}/status/${tweet.id}`;

            await connection.execute(
                `INSERT INTO cz_tweets
                (id, text, created_at, retweet_count, like_count, reply_count, quote_count, impression_count, url, username)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                retweet_count = VALUES(retweet_count),
                like_count = VALUES(like_count),
                reply_count = VALUES(reply_count),
                quote_count = VALUES(quote_count),
                impression_count = VALUES(impression_count)`,
                [
                    tweet.id,
                    tweet.text,
                    new Date(tweet.created_at),
                    tweet.public_metrics?.retweet_count || 0,
                    tweet.public_metrics?.like_count || 0,
                    tweet.public_metrics?.reply_count || 0,
                    tweet.public_metrics?.quote_count || 0,
                    tweet.public_metrics?.impression_count || 0,
                    tweetUrl,
                    username
                ]
            );
            console.log(`💾 Saved @${username} tweet: ${tweet.id}`);
        } catch (error) {
            console.error(`❌ Error saving tweet ${tweet.id}:`, error);
        }
    }
}

// Multiple account tracking
const DEFAULT_ACCOUNTS = ['cz_binance', 'CookerFlips', 'ShockedJS']; // Alpha accounts
const TEST_ACCOUNTS = ['alien88ted']; // Test accounts (live feed only, no DB)

async function setupRealTimeStream(accounts, testAccounts = []) {
    console.log('⚡ Setting up LIVE REAL-TIME stream...');

    try {
        // Get user IDs for all accounts (both production and test)
        const allAccounts = [...accounts, ...testAccounts];
        const userIds = [];
        const userMap = new Map(); // Map user IDs to usernames

        for (const username of allAccounts) {
            const userId = await getUserId(username);
            if (userId) {
                userIds.push(userId);
                userMap.set(userId, username);
                const accountType = testAccounts.includes(username) ? '[TEST]' : '[PROD]';
                console.log(`✅ ${accountType} Got ID for @${username}: ${userId}`);
            }
        }

        if (userIds.length === 0) {
            throw new Error('No valid user IDs found');
        }

        // Create streaming rules for these specific users
        const rules = userIds.map(userId => ({
            value: `from:${userId}`,
            tag: `alpha_user_${userId}`
        }));

        // Clear existing rules first
        try {
            const currentRules = await readOnlyClient.v2.streamRules();
            if (currentRules.data?.length > 0) {
                await readOnlyClient.v2.updateStreamRules({
                    delete: { ids: currentRules.data.map(rule => rule.id) }
                });
                console.log('🧹 Cleared existing stream rules');
            }
        } catch (error) {
            console.log('No existing rules to clear');
        }

        // Add new rules
        await readOnlyClient.v2.updateStreamRules({
            add: rules
        });
        console.log('📋 Added streaming rules for alpha accounts');

        // Start the stream
        const stream = await readOnlyClient.v2.searchStream({
            'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
            'user.fields': ['username']
        });

        console.log('🔴 LIVE STREAM ACTIVE - Zero latency alpha detection!');

        // Handle incoming tweets
        stream.on(ETwitterStreamEvent.Data, async (tweet) => {
            try {
                const authorId = tweet.data.author_id;
                const username = userMap.get(authorId) || 'unknown';
                const isTestAccount = testAccounts.includes(username);

                if (isTestAccount) {
                    console.log(`🧪 TEST FEED @${username}: "${tweet.data.text.substring(0, 100)}..." [FEED ONLY - NOT SAVED]`);
                } else {
                    console.log(`🚨🔥 INSTANT ALPHA @${username}: "${tweet.data.text.substring(0, 100)}..."`);
                    await saveTweetsToDb([tweet.data], username);
                }

                // Emit to connected clients immediately (both test and prod)
                const io = require('./server').io;
                if (io) {
                    io.emit('newTweets', [{
                        ...tweet.data,
                        username: username,
                        isTest: isTestAccount
                    }]);
                }
            } catch (error) {
                console.error('Error processing stream tweet:', error);
            }
        });

        stream.on(ETwitterStreamEvent.Error, (error) => {
            console.error('🔴 Stream error:', error);
            // Reconnect logic
            setTimeout(() => setupRealTimeStream(accounts, testAccounts), 5000);
        });

        stream.on(ETwitterStreamEvent.Connected, () => {
            console.log('🟢 Stream connected - LIVE alpha detection active!');
        });

        return stream;

    } catch (error) {
        console.error('❌ Failed to setup real-time stream:', error);
        console.log('⬇️  Falling back to polling mode...');
        return null;
    }
}

async function trackMultipleAccounts() {
    console.log('🚀 Starting REAL-TIME alpha tracker...');
    await initializeDB();

    // Load API usage from database
    await loadApiUsage();

    // Get accounts from env or use defaults
    const accountsEnv = process.env.TWITTER_ACCOUNTS || DEFAULT_ACCOUNTS.join(',');
    const accounts = accountsEnv.split(',').map(a => a.trim());

    console.log(`📊 Alpha accounts: ${accounts.join(', ')}`);
    console.log(`🧪 Test accounts: ${TEST_ACCOUNTS.join(', ')} [FEED ONLY]`);
    console.log(`🔴 LIVE STREAM MODE - Zero polling delay!`);

    // Try to setup real-time streaming first
    const stream = await setupRealTimeStream(accounts, TEST_ACCOUNTS);

    if (!stream) {
        console.log('📡 Setting up polling fallback...');

        // Fallback to polling if streaming fails
        const fetchNewTweets = async () => {
            console.log(`\n🔥 [POLLING] Scanning for new tweets...`);

            for (const username of accounts) {
                try {
                    const newTweets = await fetchLatestTweets(username, true);
                    if (newTweets.length > 0) {
                        console.log(`🚨 NEW ALPHA @${username}: ${newTweets.length} fresh tweets!`);
                        await saveTweetsToDb(newTweets, username);
                    }

                    if (apiUsage.requests > RATE_LIMIT * 0.9) {
                        console.log(`🚨 CRITICAL: API limit approaching, brief pause...`);
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                } catch (error) {
                    console.error(`❌ Error fetching new tweets @${username}:`, error.message);
                }
            }
        };

        // Start with initial fetch
        await fetchNewTweets();

        // High frequency polling as fallback
        console.log(`⚡ Fallback polling: every 5s`);
        setInterval(fetchNewTweets, 5000);
    }

    // Smart backfill system - initialize with oldest tweet IDs
    let backfillState = {
        currentAccount: 0,
        totalTweetsBackfilled: 0,
        lastBackfillTime: Date.now(),
        accountProgress: []
    };

    // Initialize account progress with oldest tweet IDs
    for (const username of accounts) {
        const oldestId = await getOldestTweetId(username);
        backfillState.accountProgress.push({
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

    const smartBackfill = async () => {
        const availableRequests = RATE_LIMIT - apiUsage.requests;
        const timeUntilReset = WINDOW_MS - (Date.now() - apiUsage.windowStart);

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
            console.log(`⏸️  Pausing backfill - insufficient API budget`);
            return;
        }

        let requestsUsed = 0;
        const startAccount = backfillState.currentAccount;

        // Cycle through accounts
        while (requestsUsed < maxBackfillRequests) {
            const accountInfo = backfillState.accountProgress[backfillState.currentAccount];

            if (accountInfo.completed) {
                console.log(`✅ @${accountInfo.username} backfill completed, moving to next`);
                backfillState.currentAccount = (backfillState.currentAccount + 1) % accounts.length;

                // If we've cycled through all accounts, reset
                if (backfillState.currentAccount === startAccount) {
                    console.log(`🔄 All accounts backfilled, resetting for next cycle`);
                    backfillState.accountProgress.forEach(acc => acc.completed = false);
                    break;
                }
                continue;
            }

            try {
                console.log(`📥 Backfilling @${accountInfo.username}...`);

                // Get older tweets using the last ID we processed
                const oldTweets = await fetchLatestTweets(accountInfo.username, false, accountInfo.lastBackfillId);
                requestsUsed += 2; // userTimeline + getUserId

                if (oldTweets.length > 0) {
                    // Filter out tweets we already have in DB
                    let newTweets = 0;
                    for (const tweet of oldTweets) {
                        try {
                            await saveTweetsToDb([tweet], accountInfo.username);
                            newTweets++;
                        } catch (error) {
                            if (!error.message.includes('Duplicate entry')) {
                                console.error(`Error saving tweet ${tweet.id}:`, error.message);
                            }
                            // Skip duplicates silently
                        }
                    }

                    backfillState.totalTweetsBackfilled += newTweets;
                    accountInfo.lastBackfillId = oldTweets[oldTweets.length - 1].id;

                    console.log(`📦 @${accountInfo.username}: +${newTweets}/${oldTweets.length} new tweets (${backfillState.totalTweetsBackfilled} total)`);
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
            backfillState.currentAccount = (backfillState.currentAccount + 1) % accounts.length;

            // Small delay between accounts to be nice to API
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        backfillState.lastBackfillTime = Date.now();
        console.log(`📈 Backfill session complete: used ${requestsUsed}/${maxBackfillRequests} requests`);
    };

    // Adaptive backfill intervals based on API usage
    const scheduleNextBackfill = () => {
        const currentUsage = apiUsage.requests / RATE_LIMIT;
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
        setTimeout(() => {
            smartBackfill().then(scheduleNextBackfill);
        }, intervalMs);
    };

    console.log(`🧠 Smart backfill system initialized`);

    // Start backfill after initial setup
    setTimeout(() => {
        smartBackfill().then(scheduleNextBackfill);
    }, 30000); // Wait 30s after startup
}

// Keep old function for backwards compatibility
async function trackCzTweets() {
    return trackMultipleAccounts();
}

module.exports = { trackCzTweets, fetchLatestTweets, getUserId };