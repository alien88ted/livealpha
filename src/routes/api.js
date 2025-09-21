const express = require('express');
const { getPool } = require('../config/database');
const AIService = require('../services/aiService');

const router = express.Router();

// In-memory webhook config storage (could be moved to database later)
let webhookConfigs = new Map();

// Removed unused CryptoDataService import/instance (no dependency in repo)

/**
 * Get fresh live tweets from Twitter API
 */
router.get('/tweets/live', async (req, res) => {
    try {
        console.log('🔥 API CALL: /tweets/live - Getting fresh tweets...');
        
        // Get tracker instance from app
        const tracker = req.app.get('tracker');
        if (!tracker) {
            console.log('❌ Tracker service not available');
            return res.status(500).json({ error: 'Tracker service not available' });
        }

        console.log('✅ Tracker found, calling getFreshTweets()...');
        const tweets = await tracker.getFreshTweets();
        console.log(`📊 Returning ${tweets.length} tweets to frontend`);
        
        res.json(tweets);
    } catch (error) {
        console.error('❌ Error fetching live tweets:', error.message);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ error: 'Failed to fetch live tweets', details: error.message });
    }
});

/**
 * Test endpoint to verify API is working
 */
router.get('/test', (req, res) => {
    console.log('🧪 TEST endpoint called');
    res.json({ 
        status: 'API is working', 
        timestamp: new Date().toISOString(),
        message: 'Alpha Tracker API is live!'
    });
});

/**
 * Get tweets from database (backup/history)
 */
router.get('/tweets', async (req, res) => {
    try {
        const pool = getPool();
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const [rows] = await pool.execute(
            'SELECT * FROM cz_tweets ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
        
        res.json(rows);
    } catch (error) {
        console.error('❌ Error fetching tweets from database:', error.message);
        res.status(500).json({ error: 'Failed to fetch tweets' });
    }
});

/**
 * Get tweet statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const pool = getPool();
        
        // Get total tweets
        const [totalTweets] = await pool.execute(
            'SELECT COUNT(*) as count FROM cz_tweets'
        );
        
        // Get total engagement
        const [totalEngagement] = await pool.execute(
            'SELECT SUM(like_count + retweet_count + reply_count + quote_count) as total FROM cz_tweets'
        );
        
        // Get average engagement
        const [avgEngagement] = await pool.execute(
            'SELECT AVG(like_count + retweet_count + reply_count + quote_count) as average FROM cz_tweets'
        );

        // Account breakdown
        const [accountStats] = await pool.execute(
            `SELECT 
                username, 
                COUNT(*) as tweets, 
                SUM(like_count + retweet_count + reply_count + quote_count) as engagement,
                MAX(created_at) as last_tweet,
                MIN(created_at) as first_tweet
             FROM cz_tweets 
             GROUP BY username 
             ORDER BY tweets DESC`
        );

        // Recent activity (last 24 hours)
        const [recentActivity] = await pool.execute(
            `SELECT 
                COUNT(*) as recent_tweets,
                SUM(like_count + retweet_count + reply_count + quote_count) as recent_engagement
             FROM cz_tweets 
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
        );

        res.json({
            totalTweets: totalTweets[0].count,
            totalEngagement: totalEngagement[0].total || 0,
            avgEngagement: Math.round(avgEngagement[0].average || 0),
            accountBreakdown: accountStats,
            recentActivity: {
                tweets: recentActivity[0].recent_tweets,
                engagement: recentActivity[0].recent_engagement || 0
            }
        });
    } catch (error) {
        console.error('❌ Error fetching stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * Get detailed rate limiting information
 */
router.get('/rate-limits', async (req, res) => {
    try {
        const tracker = req.app.get('tracker');
        if (!tracker) {
            return res.status(500).json({ error: 'Tracker service not available' });
        }

        const rateLimitStatus = tracker.twitterService.rateLimitManager.getRateLimitStatus();
        const usage = tracker.twitterService.getApiUsage();

        res.json({
            plan: tracker.twitterService.rateLimitManager.currentPlan,
            endpoints: rateLimitStatus,
            summary: usage.summary,
            queueStatus: {
                length: tracker.twitterService.rateLimitManager.requestQueue.length,
                processing: tracker.twitterService.rateLimitManager.isProcessingQueue
            }
        });
    } catch (error) {
        console.error('❌ Error fetching rate limit info:', error.message);
        res.status(500).json({ error: 'Failed to fetch rate limit information' });
    }
});

// AI status
router.get('/ai/status', async (req, res) => {
    try {
        // Get AI service from app (server has the AI instance)
        const ai = req.app.get('ai') || new AIService();
        const status = await ai.getStatus();
        const usage = ai.getUsageStats ? ai.getUsageStats() : null;
        res.json({ ...status, usage });
    } catch (error) {
        console.error('❌ Error fetching AI status:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI status' });
    }
});

// AI budget endpoint
router.get('/ai/budget', async (req, res) => {
    try {
        const ai = req.app.get('ai') || new AIService();
        const usage = ai.getUsageStats ? ai.getUsageStats() : null;
        res.json(usage || {});
    } catch (error) {
        console.error('❌ Error fetching AI budget:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI budget' });
    }
});

// AI memory/debug view
router.get('/ai/memory', async (req, res) => {
    try {
        const tracker = req.app.get('tracker');
        const ai = tracker?.ai || new AIService();
        const pool = getPool();

        // Tweets context used for prompts
        const [tweets] = await pool.execute(
            `SELECT id, username, text, created_at, created_at_ms
             FROM cz_tweets
             WHERE created_at_ms IS NOT NULL AND created_at_ms >= (UNIX_TIMESTAMP(NOW(6)) * 1000) - (24 * 60 * 60 * 1000)
             ORDER BY created_at_ms DESC
             LIMIT 120`
        );

        // Latest insight
        const latest = await ai.getLatestInsightRow();
        let compact = null;
        if (latest?.content) {
            try { compact = await ai.compactFromContent(latest.content); } catch {}
        }

        // Notify history
        const [history] = await pool.execute(
            `SELECT message, urgency, summary_checksum, created_at
             FROM ai_notify_history
             ORDER BY created_at DESC
             LIMIT 20`
        );

        // Status
        const status = await ai.getStatus();

        res.json({
            tweets,
            latestInsight: latest || null,
            compact: compact || null,
            notifyHistory: history,
            status,
            logs: ai.getLogs ? ai.getLogs() : []
        });
    } catch (error) {
        console.error('❌ Error fetching AI memory:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI memory' });
    }
});

// AI: get latest cached insight
router.get('/ai/insights', async (req, res) => {
    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT content, created_at FROM ai_insights ORDER BY created_at DESC LIMIT 1'
        );
        if (!rows.length) return res.json({ content: null, compact: null });
        const ai = new AIService();
        let compact = null;
        try { compact = await ai.compactFromContent(rows[0].content); } catch {}
        res.json({ content: rows[0].content, compact, createdAt: rows[0].created_at });
    } catch (error) {
        console.error('❌ Error fetching AI insight:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI insights' });
    }
});

// AI: force refresh insight (expensive)
router.post('/ai/refresh', async (req, res) => {
    try {
        const tracker = req.app.get('tracker');
        if (!tracker) return res.status(500).json({ error: 'Tracker service not available' });

        // Load last 24h tweets from DB for AI context
        const pool = getPool();
        const [rows] = await pool.execute(
            `SELECT * FROM cz_tweets WHERE created_at_ms IS NOT NULL AND created_at_ms >= (UNIX_TIMESTAMP(NOW(6)) * 1000) - (24 * 60 * 60 * 1000) ORDER BY created_at_ms DESC LIMIT 500`
        );

        const ai = new AIService();
        const latest = await ai.getLatestInsightRow();
        const result = latest ? await ai.analyzeTweets(rows) : await ai.analyzeTweetsBaseline(rows);
        res.json({ ok: true, cached: !!result.cached, skipped: !!result.skipped, content: result.content });
    } catch (error) {
        console.error('❌ Error refreshing AI insight:', error.message);
        res.status(500).json({ error: 'Failed to refresh AI insights' });
    }
});

// AI: Get past Opus analyses for tracking
router.get('/ai/opus/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const ai = new AIService();
        const pastAnalyses = await ai.getPastOpusAnalyses(limit);
        res.json({
            count: pastAnalyses.length,
            analyses: pastAnalyses
        });
    } catch (error) {
        console.error('❌ Error fetching past Opus analyses:', error.message);
        res.status(500).json({ error: 'Failed to fetch past Opus analyses' });
    }
});

/**
 * Get API usage statistics
 */
router.get('/usage', async (req, res) => {
    try {
        // Get tracker instance from app
        const tracker = req.app.get('tracker');
        if (!tracker) {
            return res.status(500).json({ error: 'Tracker service not available' });
        }

        const usage = tracker.twitterService.getApiUsage();
        const status = tracker.getStatus();

        // Calculate estimated costs (example pricing)
        const monthlyBudget = 100; // $100/month example
        const dailyBudget = monthlyBudget / 30;
        const maxDailyRequests = usage.rateLimit * 4 * 24; // 4 windows per hour * 24 hours

        res.json({
            current: usage,
            limits: {
                rateLimit: usage.rateLimit,
                windowMinutes: 15,
                dailyMax: maxDailyRequests
            },
            budget: {
                monthly: monthlyBudget,
                daily: dailyBudget,
                costPerRequest: dailyBudget / maxDailyRequests
            },
            status: {
                isRunning: status.isRunning,
                efficiency: "Optimized for real-time alpha detection"
            }
        });
    } catch (error) {
        console.error('❌ Error fetching usage stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch usage stats' });
    }
});

/**
 * Get AI usage statistics and metrics
 */
router.get('/ai/usage', async (req, res) => {
    try {
        const ai = new AIService();
        const usageStats = ai.getUsageStats();

        // Get historical usage from database (gracefully handle missing table)
        let hourlyUsage = [];
        let modelBreakdown = [];

        try {
            const pool = getPool();
            const [hourlyResult] = await pool.execute(
                `SELECT
                    DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
                    COUNT(*) as requests,
                    SUM(input_tokens + output_tokens) as tokens,
                    SUM(cost_usd) as cost,
                    AVG(execution_time_ms) as avg_latency
                 FROM ai_usage_log
                 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 GROUP BY hour
                 ORDER BY hour DESC`
            );
            hourlyUsage = hourlyResult;

            const [modelResult] = await pool.execute(
                `SELECT
                    model,
                    COUNT(*) as requests,
                    SUM(input_tokens + output_tokens) as tokens,
                    SUM(cost_usd) as cost,
                    AVG(execution_time_ms) as avg_latency
                 FROM ai_usage_log
                 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 GROUP BY model`
            );
            modelBreakdown = modelResult;
        } catch (dbError) {
            if (!dbError.message.includes("doesn't exist")) {
                console.error('❌ Database error fetching AI usage history:', dbError.message);
            }
            // Continue with empty arrays if table doesn't exist
        }

        res.json({
            current: usageStats,
            trends: {
                hourly: hourlyUsage,
                models: modelBreakdown
            },
            alerts: {
                budgetAlert: usageStats.monthly.budgetUsed > 80,
                highLatency: hourlyUsage.some(h => h.avg_latency > 10000),
                costSpike: hourlyUsage.length > 1 && hourlyUsage[0].cost > hourlyUsage[1].cost * 2
            }
        });
    } catch (error) {
        console.error('❌ Error fetching AI usage stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI usage statistics' });
    }
});

/**
 * Get tracker status
 */
router.get('/status', async (req, res) => {
    try {
        // Get tracker instance from app
        const tracker = req.app.get('tracker');
        if (!tracker) {
            return res.status(500).json({ error: 'Tracker service not available' });
        }

        const status = tracker.getStatus();
        res.json(status);
    } catch (error) {
        console.error('❌ Error fetching tracker status:', error.message);
        res.status(500).json({ error: 'Failed to fetch tracker status' });
    }
});

/**
 * Control tracker (start/stop)
 */
router.post('/control', async (req, res) => {
    try {
        const { action } = req.body;
        const tracker = req.app.get('tracker');
        
        if (!tracker) {
            return res.status(500).json({ error: 'Tracker service not available' });
        }

        switch (action) {
            case 'start':
                if (tracker.isRunning) {
                    return res.json({ message: 'Tracker is already running' });
                }
                await tracker.start();
                res.json({ message: 'Tracker started successfully' });
                break;
                
            case 'stop':
                if (!tracker.isRunning) {
                    return res.json({ message: 'Tracker is not running' });
                }
                tracker.stop();
                res.json({ message: 'Tracker stopped successfully' });
                break;
                
            case 'restart':
                tracker.stop();
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s
                await tracker.start();
                res.json({ message: 'Tracker restarted successfully' });
                break;
                
            default:
                res.status(400).json({ error: 'Invalid action. Use: start, stop, or restart' });
        }
    } catch (error) {
        console.error('❌ Error controlling tracker:', error.message);
        res.status(500).json({ error: `Failed to ${req.body.action} tracker: ${error.message}` });
    }
});

/**
 * Discord Webhook endpoints
 */

// Test webhook endpoint
router.post('/webhook/test', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'Webhook URL is required' });
        }

        // Send test message to Discord
        const testPayload = {
            embeds: [{
                title: "🧪 LiveAlpha Webhook Test",
                description: "Your Discord webhook is working correctly!",
                color: 0x00C851,
                timestamp: new Date().toISOString(),
                footer: {
                    text: "LiveAlpha • Test Message"
                }
            }]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testPayload)
        });

        if (!response.ok) {
            throw new Error(`Discord API responded with ${response.status}`);
        }

        console.log('✅ Test webhook sent successfully');
        res.json({ success: true, message: 'Test message sent successfully' });
    } catch (error) {
        console.error('❌ Error sending test webhook:', error.message);
        res.status(500).json({ error: 'Failed to send test message', details: error.message });
    }
});

// Save webhook configuration
router.post('/webhook/config', async (req, res) => {
    try {
        const config = req.body;

        if (!config.url) {
            return res.status(400).json({ error: 'Webhook URL is required' });
        }

        // Store configuration (using client ID as key, could be improved with user auth)
        const clientId = req.ip || 'default';
        const webhookConfig = {
            ...config,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        webhookConfigs.set(clientId, webhookConfig);

        // Register with the notifier service if available
        const tracker = req.app.get('tracker');
        if (tracker && tracker.notifier) {
            tracker.notifier.registerDiscordWebhook(clientId, webhookConfig);
        }

        console.log(`✅ Webhook config saved for client: ${clientId}`);
        res.json({ success: true, message: 'Webhook configuration saved' });
    } catch (error) {
        console.error('❌ Error saving webhook config:', error.message);
        res.status(500).json({ error: 'Failed to save webhook configuration' });
    }
});

// Get webhook configuration
router.get('/webhook/config', (req, res) => {
    try {
        const clientId = req.ip || 'default';
        const config = webhookConfigs.get(clientId);

        if (!config) {
            return res.json({ configured: false });
        }

        // Return config without sensitive URL
        res.json({
            configured: true,
            enabled: config.enabled,
            notifications: config.notifications,
            accounts: config.accounts,
            createdAt: config.createdAt
        });
    } catch (error) {
        console.error('❌ Error fetching webhook config:', error.message);
        res.status(500).json({ error: 'Failed to fetch webhook configuration' });
    }
});

// Function to send Discord notification (used by other services)
async function sendDiscordNotification(type, data, clientId = 'default') {
    try {
        const config = webhookConfigs.get(clientId);
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

/**
 * Get current prices for tickers
 */
router.get('/prices', async (req, res) => {
    try {
        const priceService = req.app.get('priceService');
        if (!priceService) {
            return res.status(500).json({ error: 'Price service not available' });
        }

        const { tickers } = req.query;

        if (tickers) {
            // Get specific tickers
            const tickerList = tickers.split(',').map(t => t.trim());
            const prices = {};

            for (const ticker of tickerList) {
                const price = priceService.getPrice(ticker);
                if (price) {
                    prices[ticker.replace('$', '').toUpperCase()] = price;
                }
            }

            res.json({ prices });
        } else {
            // Get all cached prices
            const allPrices = priceService.getAllPrices();
            res.json({ prices: allPrices });
        }
    } catch (error) {
        console.error('❌ Error fetching prices:', error.message);
        res.status(500).json({ error: 'Failed to fetch prices' });
    }
});

/**
 * Get price service status
 */
router.get('/prices/status', async (req, res) => {
    try {
        const priceService = req.app.get('priceService');
        if (!priceService) {
            return res.status(500).json({ error: 'Price service not available' });
        }

        const status = priceService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('❌ Error fetching price status:', error.message);
        res.status(500).json({ error: 'Failed to fetch price status' });
    }
});

/**
 * Force update prices for specific tickers
 */
router.post('/prices/update', async (req, res) => {
    try {
        const priceService = req.app.get('priceService');
        if (!priceService) {
            return res.status(500).json({ error: 'Price service not available' });
        }

        const { tickers } = req.body;
        if (!tickers || !Array.isArray(tickers)) {
            return res.status(400).json({ error: 'Tickers array required' });
        }

        await priceService.updatePrices(tickers);
        res.json({ success: true, message: `Updated prices for ${tickers.length} tickers` });
    } catch (error) {
        console.error('❌ Error updating prices:', error.message);
        res.status(500).json({ error: 'Failed to update prices' });
    }
});

/**
 * Crypto Data Endpoints
 */

// Search for tokens by symbol or name
router.get('/crypto/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const tokens = await cryptoService.searchTokens(query);
        
        res.json({
            query,
            results: tokens.slice(0, 50), // Limit results
            total_found: tokens.length
        });
    } catch (error) {
        console.error('❌ Error searching tokens:', error.message);
        res.status(500).json({ error: 'Failed to search tokens' });
    }
});

// Get token price by symbol
router.get('/crypto/price/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const token = await cryptoService.findToken(symbol);
        
        if (!token) {
            return res.status(404).json({ error: `Token not found: ${symbol}` });
        }
        
        const priceData = await cryptoService.getTokenPrice(token.id);
        
        res.json({
            symbol: token.symbol,
            name: token.name,
            id: token.id,
            price_data: priceData,
            market_cap_rank: token.market_cap_rank,
            platforms: token.platforms
        });
    } catch (error) {
        console.error('❌ Error fetching token price:', error.message);
        res.status(500).json({ error: 'Failed to fetch token price' });
    }
});

// Get batch prices for multiple tokens
router.post('/crypto/prices', async (req, res) => {
    try {
        const { symbols } = req.body;
        
        if (!symbols || !Array.isArray(symbols)) {
            return res.status(400).json({ error: 'Symbols array required' });
        }
        
        const prices = await cryptoService.getBatchPrices(symbols);
        
        res.json({
            requested: symbols,
            found: Object.keys(prices).length,
            prices
        });
    } catch (error) {
        console.error('❌ Error fetching batch prices:', error.message);
        res.status(500).json({ error: 'Failed to fetch batch prices' });
    }
});

// Get trending tokens
router.get('/crypto/trending', async (req, res) => {
    try {
        const trending = await cryptoService.getTrendingTokens();
        res.json(trending);
    } catch (error) {
        console.error('❌ Error fetching trending tokens:', error.message);
        res.status(500).json({ error: 'Failed to fetch trending tokens' });
    }
});

// Get crypto database stats
router.get('/crypto/stats', async (req, res) => {
    try {
        const stats = cryptoService.getStats();
        const globalStats = await cryptoService.getGlobalStats();
        
        res.json({
            database: stats,
            global_market: globalStats
        });
    } catch (error) {
        console.error('❌ Error fetching crypto stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch crypto stats' });
    }
});

// Force update crypto database
router.post('/crypto/update', async (req, res) => {
    try {
        console.log('🔄 Manual crypto database update triggered');
        const tokens = await cryptoService.updateTokenDatabase();
        
        res.json({
            success: true,
            message: 'Database updated successfully',
            token_count: tokens.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error updating crypto database:', error.message);
        res.status(500).json({ error: 'Failed to update crypto database' });
    }
});

// Export webhook function for use by other services
router.sendDiscordNotification = sendDiscordNotification;

module.exports = router;
