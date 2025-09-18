require('dotenv').config();

/**
 * Application configuration with environment-specific settings
 */
const config = {
    // Server configuration
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || 'localhost',
        env: process.env.NODE_ENV || 'development'
    },

    // Database configuration
    database: {
        url: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
    },

    // Twitter API configuration
    twitter: {
        bearerToken: process.env.TWITTER_BEARER_TOKEN,
        plan: process.env.TWITTER_PLAN || 'pro', // 'basic', 'pro', 'enterprise'
        accounts: {
            production: (process.env.TWITTER_ACCOUNTS || 'cz_binance,CookerFlips,ShockedJS').split(',').map(a => a.trim()),
            test: (process.env.TWITTER_TEST_ACCOUNTS || 'alien88ted').split(',').map(a => a.trim())
        }
    },

    // Rate limiting configuration based on Twitter plan
    rateLimits: {
        basic: {
            userTimeline: { requests: 75, windowMs: 15 * 60 * 1000 },
            userLookup: { requests: 300, windowMs: 15 * 60 * 1000 },
            searchStream: { requests: 50, windowMs: 15 * 60 * 1000 },
            streamRules: { requests: 25, windowMs: 15 * 60 * 1000 }
        },
        pro: {
            userTimeline: { requests: 300, windowMs: 15 * 60 * 1000 },
            userLookup: { requests: 1000, windowMs: 15 * 60 * 1000 },
            searchStream: { requests: 50, windowMs: 15 * 60 * 1000 },
            streamRules: { requests: 25, windowMs: 15 * 60 * 1000 }
        },
        enterprise: {
            userTimeline: { requests: 1000, windowMs: 15 * 60 * 1000 },
            userLookup: { requests: 3000, windowMs: 15 * 60 * 1000 },
            searchStream: { requests: 200, windowMs: 15 * 60 * 1000 },
            streamRules: { requests: 100, windowMs: 15 * 60 * 1000 }
        }
    },

    // Tracker configuration
    tracker: {
        // Polling intervals (in milliseconds)
        polling: {
            newTweets: 2 * 60 * 1000,     // 2 minutes for new tweet polling
            backfill: 5 * 60 * 1000,      // 5 minutes for backfill operations
            refresh: 30 * 1000            // 30 seconds for dashboard refresh
        },
        
        // Backfill settings
        backfill: {
            maxRequestsPerSession: 50,
            delayBetweenAccounts: 200,    // ms
            prioritizeRecent: true
        },

        // Stream settings
        stream: {
            autoReconnect: true,
            maxReconnectAttempts: Infinity,
            reconnectDelay: 5000          // ms
        }
    },

    // Logging configuration
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        enableApiLogging: process.env.NODE_ENV !== 'production',
        enablePerformanceLogging: false
    },

    // Performance settings
    performance: {
        maxConcurrentRequests: 5,
        requestTimeout: 30000,            // 30 seconds
        databaseConnectionLimit: 10,
        cacheSize: 1000                   // Number of cached rate limit records
    }
};

/**
 * Validate configuration
 */
function validateConfig() {
    const errors = [];

    if (!config.twitter.bearerToken) {
        errors.push('TWITTER_BEARER_TOKEN is required');
    }

    if (!config.database.url) {
        errors.push('DATABASE_URL is required');
    }

    if (!config.rateLimits[config.twitter.plan]) {
        errors.push(`Invalid Twitter plan: ${config.twitter.plan}. Must be 'basic', 'pro', or 'enterprise'`);
    }

    if (config.twitter.accounts.production.length === 0) {
        errors.push('At least one production Twitter account must be specified');
    }

    if (errors.length > 0) {
        console.error('❌ Configuration validation failed:');
        errors.forEach(error => console.error(`   - ${error}`));
        throw new Error('Invalid configuration');
    }

    console.log('✅ Configuration validated successfully');
}

/**
 * Get rate limits for current plan
 */
function getCurrentRateLimits() {
    return config.rateLimits[config.twitter.plan];
}

/**
 * Get environment-specific settings
 */
function getEnvironmentSettings() {
    return {
        isDevelopment: config.server.env === 'development',
        isProduction: config.server.env === 'production',
        isTest: config.server.env === 'test'
    };
}

module.exports = {
    config,
    validateConfig,
    getCurrentRateLimits,
    getEnvironmentSettings
};
