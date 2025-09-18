const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

/**
 * Initialize database connection pool with proper error handling
 */
async function initializeDB() {
    try {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is required');
        }

        const dbUrl = process.env.DATABASE_URL; // keep as-is to preserve ssl JSON for PlanetScale
        console.log('🔗 Connecting to database...');

        // Parse the database URL
        const url = new URL(dbUrl);

        // Create connection pool with optimized settings
        // Extract optional ssl param from query string for PlanetScale, e.g. ssl={"rejectUnauthorized":true}
        let ssl = false;
        const sslParam = url.searchParams.get('ssl');
        if (sslParam) {
            try {
                ssl = JSON.parse(sslParam);
            } catch {
                // fallback: if value is like {rejectUnauthorized:true}
                try { ssl = eval('(' + sslParam + ')'); } catch {}
            }
        }

        // Default SSL behavior: in production, enforce TLS; otherwise permissive
        if (!ssl) {
            ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : { rejectUnauthorized: false };
        }

        pool = mysql.createPool({
            host: url.hostname,
            port: url.port || 3306,
            user: url.username,
            password: url.password,
            database: url.pathname.substring(1),
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 60000,
            ssl
        });

        // Test the connection
        const connection = await pool.getConnection();
        console.log('✅ Database connection established');
        connection.release();

        // Create tables
        await createTables();
        
        return pool;
    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        throw error;
    }
}

/**
 * Create required database tables
 */
async function createTables() {
    try {
        // Create tweets table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS cz_tweets (
                id VARCHAR(50) PRIMARY KEY,
                text TEXT,
                created_at TIMESTAMP,
                retweet_count INT DEFAULT 0,
                like_count INT DEFAULT 0,
                reply_count INT DEFAULT 0,
                quote_count INT DEFAULT 0,
                impression_count INT DEFAULT 0,
                url VARCHAR(255),
                username VARCHAR(50) DEFAULT 'cz_binance',
				conversation_id VARCHAR(50) NULL,
				in_reply_to_status_id VARCHAR(50) NULL,
				in_reply_to_user_id VARCHAR(50) NULL,
                retrieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at),
                INDEX idx_username (username),
				INDEX idx_retrieved_at (retrieved_at),
				INDEX idx_conversation_id (conversation_id),
				INDEX idx_in_reply_to_status_id (in_reply_to_status_id)
            )
        `);

        // Create API usage tracking table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS api_usage (
                id INT AUTO_INCREMENT PRIMARY KEY,
                window_start BIGINT NOT NULL,
                requests_count INT DEFAULT 0,
                daily_date DATE NOT NULL,
                daily_requests INT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_window (window_start),
                UNIQUE KEY unique_daily (daily_date)
            )
        `);

		// Create AI insights cache table
		await pool.execute(`
			CREATE TABLE IF NOT EXISTS ai_insights (
				id INT AUTO_INCREMENT PRIMARY KEY,
				checksum VARCHAR(64) NOT NULL,
				model VARCHAR(64) NOT NULL,
				content MEDIUMTEXT NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				UNIQUE KEY unique_checksum_model (checksum, model),
				INDEX idx_created_at (created_at)
			)
		`);

		// Create AI notify state table (single-row state)
		await pool.execute(`
			CREATE TABLE IF NOT EXISTS ai_notify_state (
				id INT PRIMARY KEY DEFAULT 1,
				last_digest_at TIMESTAMP NULL,
				last_digest_checksum VARCHAR(64) NULL,
				last_urgent_at TIMESTAMP NULL,
				last_urgent_checksum VARCHAR(64) NULL,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			)
		`);

		// Create AI notify history table
		await pool.execute(`
			CREATE TABLE IF NOT EXISTS ai_notify_history (
				id INT AUTO_INCREMENT PRIMARY KEY,
				message TEXT NOT NULL,
				urgency VARCHAR(32) NULL,
				summary_checksum VARCHAR(64) NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				INDEX idx_created_at (created_at)
			)
		`);

		// Create tracked accounts table (dynamic monitored accounts)
		await pool.execute(`
			CREATE TABLE IF NOT EXISTS tracked_accounts (
				id INT AUTO_INCREMENT PRIMARY KEY,
				username VARCHAR(50) UNIQUE,
				is_test TINYINT(1) DEFAULT 0,
				added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// Add columns if they don't exist (for existing tables)
        try {
			await pool.execute(`ALTER TABLE cz_tweets ADD COLUMN username VARCHAR(50) DEFAULT 'cz_binance'`);
			console.log('✅ Added username column to existing table');
        } catch (alterError) {
            // Column might already exist, ignore the error
            if (!alterError.message.includes('Duplicate column name')) {
                console.log('ℹ️  Username column already exists');
            }
        }

		// Add conversation/thread columns if missing
		try {
			await pool.execute(`ALTER TABLE cz_tweets ADD COLUMN conversation_id VARCHAR(50) NULL`);
			console.log('✅ Added conversation_id column');
		} catch (alterError) {
			if (!alterError.message.includes('Duplicate column name')) {
				console.log('ℹ️  conversation_id column already exists');
			}
		}

		try {
			await pool.execute(`ALTER TABLE cz_tweets ADD COLUMN in_reply_to_status_id VARCHAR(50) NULL`);
			console.log('✅ Added in_reply_to_status_id column');
		} catch (alterError) {
			if (!alterError.message.includes('Duplicate column name')) {
				console.log('ℹ️  in_reply_to_status_id column already exists');
			}
		}

		try {
			await pool.execute(`ALTER TABLE cz_tweets ADD COLUMN in_reply_to_user_id VARCHAR(50) NULL`);
			console.log('✅ Added in_reply_to_user_id column');
		} catch (alterError) {
			if (!alterError.message.includes('Duplicate column name')) {
				console.log('ℹ️  in_reply_to_user_id column already exists');
			}
		}

        console.log('✅ Database tables created/verified successfully');
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
        throw error;
    }
}

/**
 * Get database connection pool
 */
function getPool() {
    if (!pool) {
        throw new Error('Database not initialized. Call initializeDB() first.');
    }
    return pool;
}

/**
 * Close database connections gracefully
 */
async function closeDB() {
    if (pool) {
        await pool.end();
        console.log('✅ Database connections closed');
    }
}

module.exports = { 
    initializeDB, 
    getPool,
    closeDB
};
