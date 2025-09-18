const express = require('express');
const { getPool } = require('../config/database');
const AIService = require('../services/aiService');

const router = express.Router();

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
        const tracker = req.app.get('tracker');
        if (!tracker) return res.status(500).json({ error: 'Tracker service not available' });
        const ai = tracker?.ai || new AIService();
        const status = await ai.getStatus();
        res.json(status);
    } catch (error) {
        console.error('❌ Error fetching AI status:', error.message);
        res.status(500).json({ error: 'Failed to fetch AI status' });
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
            `SELECT id, username, text, created_at
             FROM cz_tweets
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             ORDER BY created_at DESC
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
            `SELECT * FROM cz_tweets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY created_at DESC LIMIT 500`
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

module.exports = router;
