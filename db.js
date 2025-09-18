const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

async function initializeDB() {
    const dbUrl = process.env.DATABASE_URL.replace(/['"]/g, '');

    // Parse the database URL and add SSL configuration
    const url = new URL(dbUrl);

    pool = mysql.createPool({
        host: url.hostname,
        port: url.port || 3306,
        user: url.username,
        password: url.password,
        database: url.pathname.substring(1),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: {
            rejectUnauthorized: true
        }
    });

    try {
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
                retrieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at),
                INDEX idx_username (username)
            )
        `);

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

        // Add username column if it doesn't exist (for existing tables)
        try {
            await pool.execute(`
                ALTER TABLE cz_tweets ADD COLUMN username VARCHAR(50) DEFAULT 'cz_binance'
            `);
            console.log('Added username column to existing table');
        } catch (alterError) {
            // Column might already exist, ignore the error
            if (!alterError.message.includes('Duplicate column name')) {
                console.log('Username column already exists or other alter error:', alterError.message);
            }
        }
        console.log('Database tables created successfully');
    } catch (error) {
        console.error('Error creating tables:', error);
    }
}

module.exports = { initializeDB, pool: () => pool };