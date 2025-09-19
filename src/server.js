const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const TrackerService = require('./services/trackerService');
const apiRoutes = require('./routes/api');
const NotifierService = require('./services/notifierService');
const AIService = require('./services/aiService');
const PriceService = require('./services/priceService');
const { getPool } = require('./config/database');
require('dotenv').config();

class AlphaTrackerServer {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        this.tracker = new TrackerService();
		this.notifier = new NotifierService();
		this.ai = new AIService();
		this.priceService = new PriceService();
        this.connectedClients = 0;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketIO();
        this.setupGracefulShutdown();
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '../public')));
        
        // Make tracker available to routes
        this.app.set('tracker', this.tracker);
        this.app.set('ai', this.ai);
        this.app.set('priceService', this.priceService);

        // Connect notifier to tracker
        this.tracker.notifier = this.notifier;
        
        // Request logging middleware
        this.app.use((req, res, next) => {
            console.log(`📡 ${req.method} ${req.path} - ${new Date().toISOString()}`);
            next();
        });
    }

    /**
     * Setup API routes
     */
    setupRoutes() {
        // API routes
        this.app.use('/api', apiRoutes);
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            const status = this.tracker.getStatus();
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                tracker: {
                    running: status.isRunning,
                    apiUsage: status.apiUsage.usagePercentage
                },
                database: 'connected',
                connectedClients: this.connectedClients
            });
        });

        // Serve dashboard
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/index.html'));
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Endpoint not found' });
        });

        // Global error handler
        this.app.use((error, req, res, next) => {
            console.error('❌ Server error:', error.message);
            res.status(500).json({ 
                error: 'Internal server error',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
            });
        });
    }

    /**
     * Setup Socket.IO for real-time updates
     */
    setupSocketIO() {
		this.io.on('connection', (socket) => {
            this.connectedClients++;
            console.log(`🔌 Client connected (${this.connectedClients} total)`);

            // Send current status to new client
            socket.emit('status', this.tracker.getStatus());

            socket.on('disconnect', () => {
                this.connectedClients--;
                console.log(`🔌 Client disconnected (${this.connectedClients} total)`);
            });

            // Handle client requests for fresh data
            socket.on('requestFreshData', async () => {
                try {
				const tweets = await this.tracker.getFreshTweets();
                    socket.emit('freshTweets', tweets);
                } catch (error) {
                    console.error('❌ Error fetching fresh data for client:', error.message);
                    socket.emit('error', { message: 'Failed to fetch fresh data' });
                }
            });
        });

        // Make io available globally for the tracker service
		global.io = this.io;
		global.notify = async (tweets) => {
			try {
				await this.notifier.notifyNewTweets(Array.isArray(tweets) ? tweets : [tweets]);
			} catch (e) {
				console.error('❌ Notifier error:', e.message);
			}
		};

		// Periodically process Telegram admin commands to add accounts
		setInterval(async () => {
			try {
				await this.notifier.processAdminCommands(async (username) => {
					console.log(`🛠️  Admin requested add account: @${username}`);
					const pool = getPool();
					await pool.execute('INSERT IGNORE INTO tracked_accounts (username, is_test) VALUES (?, 0)', [username]);
					// Update in-memory tracker and re-sync
					if (!this.tracker.dynamicAccounts.has(username)) {
						this.tracker.dynamicAccounts.add(username);
						// kick off an immediate sync for this account
						await this.tracker.syncLatestTweets(24);
					}
				});
			} catch (e) {
				console.error('❌ Admin command loop error:', e.message);
			}
		}, 5000);

		global.aiMaybeUpdate = async () => {
			try {
				// Build context from last 24h
				const pool = getPool();
				const [rows] = await pool.execute(
					`SELECT * FROM cz_tweets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY created_at DESC LIMIT 500`
				);
				// Ensure we always have a status: if none in DB, generate baseline
				// Fire a fast-path urgent alert if needed (non-blocking)
				this.ai.maybeSendHaikuFlash(rows).catch(() => {});

				const latest = await this.ai.getLatestInsightRow();
				const result = latest ? await this.ai.analyzeTweets(rows) : await this.ai.analyzeTweetsBaseline(rows);
				if (result.content) {
					let compact = { tickers: [], headline: '' };
					try { compact = await this.ai.compactFromContent(result.content); } catch {}

					// Update prices for AI-suggested tickers
					if (compact.tickers && compact.tickers.length > 0) {
						this.priceService.updateAISuggestedPrices(compact.tickers).catch(() => {});
					}

					this.io.emit('aiInsights', { content: result.content, compact, cached: !!result.cached });
					// Ask Sonnet if TG notification should be sent based on history
					this.ai.maybeTelegramNotifyFromSummary(result.content).catch(() => {});
				}

				// Periodic digest (every hour) regardless of change
				this.ai.maybeSendDigest(rows).catch(() => {});
			} catch (e) {
				console.error('❌ AI update error:', e.message);
			}
		};
    }

    /**
     * Setup graceful shutdown handlers
     */
    setupGracefulShutdown() {
        const shutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            
            // Stop tracker
            this.tracker.stop();
            
            // Close server
            this.server.close(() => {
                console.log('✅ HTTP server closed');
                process.exit(0);
            });

            // Force exit after 10 seconds
            setTimeout(() => {
                console.log('❌ Force exit after timeout');
                process.exit(1);
            }, 10000);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            shutdown('UNCAUGHT_EXCEPTION');
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            shutdown('UNHANDLED_REJECTION');
        });
    }

    /**
     * Start the server on available port
     */
    async start() {
        const tryPorts = [3000, 3001, 3002, 3003, 3004, 3005, 8080, 8081, 8082, 5000, 5001, 5002];
        const targetPort = process.env.PORT || tryPorts[0];

        // If PORT is specified in env, try only that port
        const portsToTry = process.env.PORT ? [targetPort] : tryPorts;

        for (const port of portsToTry) {
            try {
                await this.startOnPort(port);
                console.log(`\n🚀 Alpha Tracker Server running on http://localhost:${port}`);
                console.log(`📊 Dashboard available at http://localhost:${port}`);
                console.log(`🔄 Real-time tracking: ACTIVE\n`);
                
                // Start the tracker service
                await this.tracker.start();
                
                return port;
            } catch (error) {
                if (error.code === 'EADDRINUSE') {
                    console.log(`⚠️  Port ${port} is in use, trying next port...`);
                    if (port === portsToTry[portsToTry.length - 1]) {
                        throw new Error('All ports are in use. Please specify a custom PORT in .env');
                    }
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * Start server on specific port
     */
    startOnPort(port) {
        return new Promise((resolve, reject) => {
            const tempServer = this.server.listen(port);

            tempServer.on('listening', () => {
                resolve(port);
            });

            tempServer.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Database polling for new tweets (backup mechanism)
     */
    async startDatabasePolling() {
        const pool = getPool();
        let lastCheck = new Date();

        const pollDatabase = async () => {
            try {
                const [rows] = await pool.execute(
                    'SELECT * FROM cz_tweets WHERE retrieved_at > ? ORDER BY created_at DESC LIMIT 10',
                    [lastCheck]
                );

                if (rows.length > 0) {
                    console.log(`📬 Database polling found ${rows.length} new tweets`);
                    this.io.emit('newTweets', rows);
                    lastCheck = new Date();
                }
            } catch (error) {
                console.error('❌ Error polling database for new tweets:', error.message);
            }
        };

        // Poll every 5 seconds
        setInterval(pollDatabase, 5000);
        console.log('📡 Database polling started (5s interval)');
    }
}

// Create and start server
async function main() {
    console.log('🚀 Starting Alpha Tracker Server...');
    try {
        const server = new AlphaTrackerServer();
        await server.start();
        
        // Start database polling as backup
        setTimeout(() => {
            server.startDatabasePolling();
        }, 5000);

        // Start rate limit cleanup job (runs every hour)
        setInterval(() => {
            if (server.tracker && server.tracker.twitterService && server.tracker.twitterService.rateLimitManager) {
                server.tracker.twitterService.rateLimitManager.cleanupOldRecords();
            }
        }, 60 * 60 * 1000); // 1 hour
        
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

// Export for testing
module.exports = { AlphaTrackerServer };

// Start server if this file is run directly
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Failed to start application:', error.message);
        process.exit(1);
    });
}
