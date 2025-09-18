const { getPool } = require('../config/database');

class RateLimitManager {
    constructor() {
        // Twitter API v2 rate limits for different plans
        this.rateLimits = {
            // Basic/Essential plan limits
            basic: {
                userTimeline: { requests: 75, windowMs: 15 * 60 * 1000 }, // 75 per 15 min
                userLookup: { requests: 300, windowMs: 15 * 60 * 1000 }, // 300 per 15 min
                searchStream: { requests: 50, windowMs: 15 * 60 * 1000 }, // 50 connections per 15 min
                streamRules: { requests: 25, windowMs: 15 * 60 * 1000 } // 25 per 15 min
            },
            // Pro plan limits ($5000/month) - AGGRESSIVE USAGE FOR SPEED
            pro: {
                userTimeline: { requests: 280, windowMs: 15 * 60 * 1000 }, // Use 280/300 aggressively
                userLookup: { requests: 900, windowMs: 15 * 60 * 1000 }, // Use 900/1000 aggressively  
                searchStream: { requests: 45, windowMs: 15 * 60 * 1000 }, // Use 45/50 aggressively
                streamRules: { requests: 20, windowMs: 15 * 60 * 1000 } // Use 20/25 aggressively
            }
        };

        // Current plan (can be configured via environment)
        this.currentPlan = process.env.TWITTER_PLAN || 'pro';
        this.limits = this.rateLimits[this.currentPlan];

        // In-memory cache for rate limit status
        this.rateLimitCache = new Map();
        
        // Request queue for managing API calls
        this.requestQueue = [];
        this.isProcessingQueue = false;
        
        console.log(`📊 Rate Limit Manager initialized for ${this.currentPlan} plan`);
        this.logRateLimits();
    }

    /**
     * Log current rate limits for transparency
     */
    logRateLimits() {
        console.log('📋 Current Rate Limits:');
        Object.entries(this.limits).forEach(([endpoint, limit]) => {
            console.log(`   ${endpoint}: ${limit.requests} requests per ${limit.windowMs / 60000} minutes`);
        });
    }

    /**
     * Check if we can make a request to a specific endpoint
     */
    async canMakeRequest(endpoint, accountId = null) {
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;
        const limit = this.limits[endpoint];
        
        if (!limit) {
            console.warn(`⚠️  Unknown endpoint: ${endpoint}`);
            return true; // Allow unknown endpoints but log warning
        }

        const now = Date.now();
        const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
        
        try {
            // Get current usage from database
            const usage = await this.getCurrentUsage(endpoint, windowStart, accountId);
            const remaining = limit.requests - usage.count;
            
            // Update cache
            this.rateLimitCache.set(key, {
                endpoint,
                windowStart,
                count: usage.count,
                limit: limit.requests,
                remaining,
                resetTime: windowStart + limit.windowMs,
                lastUpdated: now
            });

            const canProceed = remaining > 0;
            
            if (!canProceed) {
                const resetIn = (windowStart + limit.windowMs - now) / 1000;
                console.warn(`🚨 Rate limit reached for ${endpoint}. Resets in ${Math.ceil(resetIn)}s`);
            }
            
            return canProceed;
        } catch (error) {
            console.error(`❌ Error checking rate limit for ${endpoint}:`, error.message);
            return false; // Fail safe - don't allow requests if we can't check limits
        }
    }

    /**
     * Record a successful API request
     */
    async recordRequest(endpoint, accountId = null, responseHeaders = null) {
        const now = Date.now();
        const limit = this.limits[endpoint];
        
        if (!limit) return;

        const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;

        try {
            // Update database
            await this.incrementUsage(endpoint, windowStart, accountId);
            
            // Update cache
            const cached = this.rateLimitCache.get(key);
            if (cached && cached.windowStart === windowStart) {
                cached.count++;
                cached.remaining = Math.max(0, limit.requests - cached.count);
                cached.lastUpdated = now;
            }

            // Parse Twitter's rate limit headers if available
            if (responseHeaders) {
                this.updateFromTwitterHeaders(endpoint, responseHeaders, accountId);
            }

            // Log usage periodically
            const usage = this.rateLimitCache.get(key);
            if (usage && usage.count % 10 === 0) {
                console.log(`📊 ${endpoint}: ${usage.count}/${usage.limit} (${usage.remaining} remaining)`);
            }

        } catch (error) {
            console.error(`❌ Error recording request for ${endpoint}:`, error.message);
        }
    }

    /**
     * Update rate limit info from Twitter's response headers
     */
    updateFromTwitterHeaders(endpoint, headers, accountId = null) {
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;
        
        const remaining = parseInt(headers['x-rate-limit-remaining']) || null;
        const resetTime = parseInt(headers['x-rate-limit-reset']) || null;
        const limit = parseInt(headers['x-rate-limit-limit']) || null;

        if (remaining !== null && resetTime !== null) {
            const cached = this.rateLimitCache.get(key);
            if (cached) {
                cached.remaining = remaining;
                cached.resetTime = resetTime * 1000; // Convert to milliseconds
                if (limit) cached.limit = limit;
                cached.lastUpdated = Date.now();
                
                console.log(`📊 Updated from Twitter headers - ${endpoint}: ${cached.count}/${cached.limit} (${remaining} remaining, resets at ${new Date(resetTime * 1000).toISOString()})`);
            }
        }
    }

    /**
     * Get current usage from database
     */
    async getCurrentUsage(endpoint, windowStart, accountId = null) {
        const pool = getPool();
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;

        try {
            const [rows] = await pool.execute(
                `SELECT requests_count as count, last_updated 
                 FROM rate_limits 
                 WHERE endpoint_key = ? AND window_start = ?`,
                [key, windowStart]
            );

            return rows.length > 0 ? rows[0] : { count: 0, last_updated: null };
        } catch (error) {
            // If table doesn't exist, create it
            if (error.code === 'ER_NO_SUCH_TABLE') {
                await this.createRateLimitTable();
                return { count: 0, last_updated: null };
            }
            throw error;
        }
    }

    /**
     * Increment usage counter in database
     */
    async incrementUsage(endpoint, windowStart, accountId = null) {
        const pool = getPool();
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;
        const now = new Date();

        await pool.execute(
            `INSERT INTO rate_limits (endpoint_key, endpoint, window_start, requests_count, last_updated, account_id)
             VALUES (?, ?, ?, 1, ?, ?)
             ON DUPLICATE KEY UPDATE 
             requests_count = requests_count + 1,
             last_updated = VALUES(last_updated)`,
            [key, endpoint, windowStart, now, accountId]
        );
    }

    /**
     * Create rate limits tracking table
     */
    async createRateLimitTable() {
        const pool = getPool();
        
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS rate_limits (
                id INT AUTO_INCREMENT PRIMARY KEY,
                endpoint_key VARCHAR(100) NOT NULL,
                endpoint VARCHAR(50) NOT NULL,
                window_start BIGINT NOT NULL,
                requests_count INT DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                account_id VARCHAR(50) NULL,
                UNIQUE KEY unique_endpoint_window (endpoint_key, window_start),
                INDEX idx_endpoint (endpoint),
                INDEX idx_window_start (window_start),
                INDEX idx_last_updated (last_updated)
            )
        `);
        
        console.log('✅ Rate limits table created');
    }

    /**
     * Add request to queue for controlled execution
     */
    async queueRequest(requestFn, endpoint, priority = 0, accountId = null) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                requestFn,
                endpoint,
                accountId,
                priority,
                resolve,
                reject,
                timestamp: Date.now()
            });

            // Sort queue by priority (higher priority first)
            this.requestQueue.sort((a, b) => b.priority - a.priority);

            // Start processing if not already running
            if (!this.isProcessingQueue) {
                this.processQueue();
            }
        });
    }

    /**
     * Process the request queue with proper rate limiting
     */
    async processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        console.log(`🔄 Processing request queue (${this.requestQueue.length} requests)`);

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            const { requestFn, endpoint, accountId, resolve, reject } = request;

            try {
                // Check if we can make the request
                const canProceed = await this.canMakeRequest(endpoint, accountId);
                
                if (!canProceed) {
                    // Wait until we can make the request
                    const waitTime = await this.getWaitTime(endpoint, accountId);
                    if (waitTime > 0) {
                        console.log(`⏸️  Waiting ${Math.ceil(waitTime / 1000)}s before next ${endpoint} request`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                }

                // Make the request
                const result = await requestFn();
                
                // Record the successful request
                await this.recordRequest(endpoint, accountId, result?.headers);
                
                resolve(result);

                // Pro plan - minimal delay between requests for SPEED
                await new Promise(resolve => setTimeout(resolve, 50));

            } catch (error) {
                console.error(`❌ Request failed for ${endpoint}:`, error.message);
                
                    // Check if it's a rate limit error
                    if (error.status === 429 || error.code === 429) {
                        console.error(`🚨 429 ERROR DETAILS:`, {
                            endpoint,
                            accountId,
                            errorMessage: error.message,
                            errorData: error.data,
                            headers: error.headers
                        });
                        
                        // For Pro plan, be VERY aggressive - 1 second wait only
                        const waitTime = 1000; // Just 1 second for $5000/month plan!
                        
                        // Put the request back in queue with lower priority
                        request.priority = Math.max(0, request.priority - 1);
                        this.requestQueue.unshift(request);
                        
                        console.log(`🚨 PRO PLAN 429 - Retrying in ${waitTime/1000}s (we pay $5000/month!)`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        reject(error);
                    }
            }
        }

        this.isProcessingQueue = false;
        console.log('✅ Request queue processing completed');
    }

    /**
     * Calculate wait time until we can make another request
     */
    async getWaitTime(endpoint, accountId = null) {
        const key = accountId ? `${endpoint}_${accountId}` : endpoint;
        const cached = this.rateLimitCache.get(key);
        
        if (!cached || cached.remaining > 0) {
            return 0;
        }

        const now = Date.now();
        const waitTime = Math.max(0, cached.resetTime - now);
        return waitTime;
    }

    /**
     * Get current rate limit status for all endpoints
     */
    getRateLimitStatus() {
        const status = {};
        
        for (const [key, data] of this.rateLimitCache.entries()) {
            status[key] = {
                endpoint: data.endpoint,
                used: data.count,
                limit: data.limit,
                remaining: data.remaining,
                resetTime: data.resetTime,
                usagePercentage: Math.round((data.count / data.limit) * 100),
                timeUntilReset: Math.max(0, data.resetTime - Date.now())
            };
        }

        return status;
    }

    /**
     * Clean up old rate limit records
     */
    async cleanupOldRecords() {
        const pool = getPool();
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago

        try {
            const [result] = await pool.execute(
                'DELETE FROM rate_limits WHERE window_start < ?',
                [cutoffTime]
            );
            
            if (result.affectedRows > 0) {
                console.log(`🧹 Cleaned up ${result.affectedRows} old rate limit records`);
            }
        } catch (error) {
            console.error('❌ Error cleaning up old rate limit records:', error.message);
        }
    }
}

module.exports = RateLimitManager;
