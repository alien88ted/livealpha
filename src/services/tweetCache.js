class TweetCache {
    constructor() {
        this.cache = new Map(); // username -> tweets array
        this.lastFetch = new Map(); // username -> timestamp
        this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache for fresh tweets
        this.MAX_TWEETS_PER_ACCOUNT = 50; // Keep more tweets in cache
        
        console.log('🧠 Smart Tweet Cache initialized - Pro Plan optimized');
    }

    /**
     * Get cached tweets for an account if still fresh
     */
    getCachedTweets(username) {
        const now = Date.now();
        const lastFetch = this.lastFetch.get(username) || 0;
        const cacheAge = now - lastFetch;
        
        if (cacheAge < this.CACHE_DURATION && this.cache.has(username)) {
            const tweets = this.cache.get(username);
            console.log(`⚡ CACHE HIT: ${tweets.length} tweets for @${username} (${Math.floor(cacheAge/1000)}s old)`);
            return tweets;
        }
        
        console.log(`🔄 CACHE MISS: @${username} needs fresh data (${Math.floor(cacheAge/1000)}s old)`);
        return null;
    }

    /**
     * Cache tweets for an account
     */
    cacheTweets(username, tweets) {
        if (!tweets || tweets.length === 0) {
            console.log(`⚠️  Not caching empty tweets for @${username}`);
            return;
        }

        // Filter to last 24 hours and sort by date
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const freshTweets = tweets
            .filter(tweet => new Date(tweet.created_at) > twentyFourHoursAgo)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, this.MAX_TWEETS_PER_ACCOUNT);

        this.cache.set(username, freshTweets);
        this.lastFetch.set(username, Date.now());
        
        console.log(`💾 CACHED: ${freshTweets.length} fresh tweets for @${username}`);
    }

    /**
     * Add new tweet to cache (from real-time stream)
     */
    addNewTweet(username, tweet) {
        const cachedTweets = this.cache.get(username) || [];
        
        // Check if tweet already exists
        const existingIndex = cachedTweets.findIndex(t => t.id === tweet.id);
        if (existingIndex !== -1) {
            return; // Already have this tweet
        }

        // Add to beginning (newest first)
        cachedTweets.unshift(tweet);
        
        // Keep only recent tweets
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const freshTweets = cachedTweets
            .filter(t => new Date(t.created_at) > twentyFourHoursAgo)
            .slice(0, this.MAX_TWEETS_PER_ACCOUNT);

        this.cache.set(username, freshTweets);
        this.lastFetch.set(username, Date.now()); // Update fetch time
        
        console.log(`⚡ ADDED NEW TWEET to cache: @${username} now has ${freshTweets.length} cached tweets`);
    }

    /**
     * Get all cached tweets across accounts
     */
    getAllCachedTweets() {
        const allTweets = [];
        
        for (const [username, tweets] of this.cache.entries()) {
            const processedTweets = tweets.map(tweet => ({
                ...tweet,
                username: username,
                url: tweet.url || `https://twitter.com/${username}/status/${tweet.id}`
            }));
            allTweets.push(...processedTweets);
        }

        // Sort by created_at descending
        allTweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        return allTweets;
    }

    /**
     * Clear old cache entries
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [username, lastFetch] of this.lastFetch.entries()) {
            if (now - lastFetch > this.CACHE_DURATION * 2) { // Clean after 10 minutes
                this.cache.delete(username);
                this.lastFetch.delete(username);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} old cache entries`);
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const stats = {
            totalAccounts: this.cache.size,
            totalTweets: 0,
            cacheHitRate: 0,
            accounts: {}
        };

        for (const [username, tweets] of this.cache.entries()) {
            stats.totalTweets += tweets.length;
            stats.accounts[username] = {
                tweets: tweets.length,
                lastFetch: this.lastFetch.get(username),
                age: Date.now() - (this.lastFetch.get(username) || 0)
            };
        }

        return stats;
    }
}

module.exports = TweetCache;
