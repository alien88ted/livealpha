# 🔴 LIVE Alpha Twitter Tracker

A real-time Twitter monitoring system built for alpha hunting, featuring zero-latency tweet streaming, smart backfill, and comprehensive analytics.

## ✨ Features

- **🔴 Real-time Streaming**: Zero-latency tweet detection using Twitter API v2 Filtered Stream
- **📊 Multi-account Tracking**: Monitor multiple Twitter accounts simultaneously
- **🧠 Smart Backfill**: Intelligent historical tweet collection with API rate limiting
- **📈 Live Dashboard**: Real-time web interface with Socket.IO updates
- **🎯 Alpha-focused**: Optimized for cryptocurrency and trading signal detection
- **🛡️ Production Ready**: Robust error handling, graceful shutdowns, and monitoring

## 🏗️ Architecture

```
cz-twitter-tracker/
├── src/
│   ├── config/
│   │   └── database.js          # Database configuration and connection
│   ├── services/
│   │   ├── twitterService.js    # Twitter API v2 integration
│   │   └── trackerService.js    # Main tracking orchestration
│   ├── routes/
│   │   └── api.js              # REST API endpoints
│   └── server.js               # Express server and Socket.IO
├── public/
│   └── index.html              # Live dashboard interface
├── env.example                 # Environment variables template
└── server.js                   # Legacy compatibility layer
```

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ and npm
- MySQL database
- Twitter Developer Account with API v2 access

### 1. Clone and Install

```bash
git clone <repository-url>
cd cz-twitter-tracker
npm install
```

### 2. Environment Setup

Copy `env.example` to `.env` and configure:

```bash
cp env.example .env
```

Edit `.env` with your credentials:

```env
# Twitter API Configuration
TWITTER_BEARER_TOKEN=your_twitter_bearer_token_here

# Database Configuration  
DATABASE_URL=mysql://username:password@host:port/database_name

# Server Configuration
PORT=3000

# Twitter Accounts to Track (comma-separated)
TWITTER_ACCOUNTS=cz_binance,CookerFlips,ShockedJS

# Environment
NODE_ENV=development
```

### 3. Database Setup

The application will automatically create the required tables:
- `cz_tweets`: Stores tweet data and metrics
- `api_usage`: Tracks API rate limiting

### 4. Twitter API Setup

1. Create a Twitter Developer Account at [developer.twitter.com](https://developer.twitter.com)
2. Create a new App with API v2 access
3. Generate a Bearer Token
4. Add the Bearer Token to your `.env` file

### 5. Start the Application

```bash
# Development mode
npm run dev

# Production mode  
npm start
```

The dashboard will be available at `http://localhost:3000`

## 📊 API Endpoints

### Live Tweets
- `GET /api/tweets/live` - Fresh tweets from Twitter API
- `GET /api/tweets` - Historical tweets from database

### Statistics
- `GET /api/stats` - Tweet and engagement statistics
- `GET /api/usage` - API usage and rate limiting stats
- `GET /api/status` - Tracker service status

### Control
- `POST /api/control` - Start/stop/restart tracker
  ```json
  { "action": "start|stop|restart" }
  ```

### Health Check
- `GET /health` - Service health status

## 🔧 Configuration

### Tracked Accounts

Configure accounts in `.env`:
```env
TWITTER_ACCOUNTS=cz_binance,CookerFlips,ShockedJS,your_account
```

### Rate Limiting

The system automatically manages Twitter API rate limits:
- **300 requests per 15 minutes** for Bearer Token
- Smart backfill scheduling based on usage
- Automatic pausing when approaching limits

### Test Accounts

Test accounts show in the live feed but aren't saved to database:
- Modify `TEST_ACCOUNTS` in `src/services/trackerService.js`

## 🎯 Real-time Features

### Streaming vs Polling

1. **Primary**: Twitter API v2 Filtered Stream (zero latency)
2. **Fallback**: High-frequency polling (10-second intervals)
3. **Backup**: Database polling for missed tweets

### Smart Backfill

- Automatically fills historical gaps
- Adapts frequency based on API usage
- Prioritizes recent tweets over old ones
- Handles rate limiting intelligently

## 📱 Dashboard Features

- **Live Tweet Feed**: Real-time updates via WebSocket
- **Account Filtering**: Toggle accounts on/off
- **Statistics**: Engagement metrics and counts
- **Status Monitoring**: API usage and connection status
- **Test Mode**: Separate test account feeds

## 🛠️ Development

### Project Structure

- **Services**: Core business logic (Twitter API, tracking)
- **Routes**: REST API endpoints
- **Config**: Database and environment configuration
- **Public**: Static dashboard files

### Adding New Features

1. **New API endpoint**: Add to `src/routes/api.js`
2. **New service**: Create in `src/services/`
3. **Database changes**: Update `src/config/database.js`
4. **Frontend updates**: Modify `public/index.html`

### Error Handling

The system includes comprehensive error handling:
- Database connection failures
- Twitter API errors and rate limiting
- Network connectivity issues
- Graceful shutdowns

## 📈 Monitoring

### Health Checks

Monitor service health at `/health`:
```json
{
  "status": "healthy",
  "tracker": { "running": true, "apiUsage": 45 },
  "database": "connected",
  "connectedClients": 3
}
```

### Logging

- Real-time console logging
- API usage tracking
- Error reporting with context
- Performance metrics

## 🔒 Security

- Environment variable protection
- CORS configuration
- Input validation
- SQL injection prevention
- Rate limiting protection

## 📊 Performance

### Optimizations

- Connection pooling for database
- Smart API usage management  
- Efficient real-time streaming
- Minimal polling overhead
- Memory-efficient data structures

### Scaling

- Horizontal scaling ready
- Database indexing optimized
- Stateless service design
- Load balancer compatible

## 🐛 Troubleshooting

### Common Issues

1. **"TWITTER_BEARER_TOKEN is required"**
   - Add your Bearer Token to `.env`

2. **Database connection errors**
   - Verify `DATABASE_URL` format
   - Check database server accessibility

3. **API rate limiting**
   - Monitor `/api/usage` endpoint
   - Adjust backfill frequency if needed

4. **Stream disconnections**
   - Auto-reconnect is enabled
   - Check network connectivity
   - Verify Twitter API status

### Debug Mode

Set `NODE_ENV=development` for detailed logging.

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions:
1. Check the troubleshooting section
2. Review the logs for error details
3. Open an issue with reproduction steps
