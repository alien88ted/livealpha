const axios = require('axios');

class PriceService {
    constructor() {
        // Multiple API providers for redundancy
        this.providers = {
            coingecko: {
                baseUrl: 'https://api.coingecko.com/api/v3',
                key: null, // Free tier
                enabled: true
            },
            coinmarketcap: {
                baseUrl: 'https://pro-api.coinmarketcap.com/v1',
                key: process.env.COINMARKETCAP_API_KEY,
                enabled: Boolean(process.env.COINMARKETCAP_API_KEY)
            },
            binance: {
                baseUrl: 'https://api.binance.com/api/v3',
                key: null, // Free tier
                enabled: true
            }
        };

        this.cache = new Map(); // ticker -> { price, change24h, lastUpdated }
        this.updateInterval = 60000; // 1 minute
        this.isUpdating = false;

        // Common ticker symbol to CoinMarketCap ID mapping
        this.symbolToId = {
            'ASTER': 36341,
            'BTC': 1,
            'ETH': 1027,
            'SOL': 5426,
            'AVAX': 5805,
            'LINK': 1975,
            'UNI': 7083,
            'AAVE': 7278,
            'SUSHI': 6758,
            'DOGE': 74,
            'ADA': 2010,
            'DOT': 6636,
            'MATIC': 3890,
            'ATOM': 3794,
            'NEAR': 6535,
            'FTM': 3513,
            'ALGO': 4030,
            'XRP': 52,
            'LTC': 2,
            'BCH': 1831,
            'XLM': 512,
            'VET': 3077,
            'ICP': 8916,
            'FLOW': 4558,
            'SAND': 6210,
            'MANA': 1966,
            'CRV': 6538,
            'COMP': 5692,
            'YFI': 5864,
            'SNX': 2586,
            'MKR': 1518,
            'RUNE': 4157,
            'LUNA': 4172,
            'UST': 7129,
            'SHIB': 5994,
            'APE': 18876,
            'LDO': 8000,
            'FTT': 4195,
            'GMT': 16352,
            'STEPN': 16352,
            'APT': 21794,
            'SUI': 20947,
            'ARB': 11841,
            'OP': 11840,
            'BLUR': 23121,
            'PEPE': 24478,
            'WLD': 13502,
            'SEI': 23149,
            'TIA': 22861,
            'PYTH': 28177,
            'JUP': 29210,
            'WIF': 28752,
            'BONK': 23095,
            'ONDO': 15069,
            'FLOKI': 9674,
            'NEIRO': 31157,
            'EIGEN': 31663
        };

        // CoinGecko symbol mapping (different from CMC)
        this.coingeckoIds = {
            'ASTER': 'astar',
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'SOL': 'solana',
            'AVAX': 'avalanche-2',
            'LINK': 'chainlink',
            'UNI': 'uniswap',
            'AAVE': 'aave',
            'SUSHI': 'sushi',
            'DOGE': 'dogecoin',
            'ADA': 'cardano',
            'DOT': 'polkadot',
            'MATIC': 'matic-network',
            'ATOM': 'cosmos',
            'NEAR': 'near',
            'FTM': 'fantom',
            'ALGO': 'algorand',
            'XRP': 'ripple',
            'LTC': 'litecoin',
            'BCH': 'bitcoin-cash',
            'XLM': 'stellar',
            'VET': 'vechain',
            'ICP': 'internet-computer',
            'FLOW': 'flow',
            'SAND': 'the-sandbox',
            'MANA': 'decentraland',
            'CRV': 'curve-dao-token',
            'COMP': 'compound-governance-token',
            'YFI': 'yearn-finance',
            'SNX': 'havven',
            'MKR': 'maker',
            'RUNE': 'thorchain',
            'LUNA': 'terra-luna',
            'SHIB': 'shiba-inu',
            'APE': 'apecoin',
            'LDO': 'lido-dao',
            'FTT': 'ftx-token',
            'GMT': 'stepn',
            'APT': 'aptos',
            'SUI': 'sui',
            'ARB': 'arbitrum',
            'OP': 'optimism',
            'BLUR': 'blur',
            'PEPE': 'pepe',
            'WLD': 'worldcoin-wld',
            'SEI': 'sei-network',
            'TIA': 'celestia',
            'PYTH': 'pyth-network',
            'JUP': 'jupiter-exchange-solana',
            'WIF': 'dogwifcoin',
            'BONK': 'bonk',
            'ONDO': 'ondo-finance',
            'FLOKI': 'floki',
            'NEIRO': 'first-neiro-on-ethereum',
            'EIGEN': 'eigenlayer'
        };

        // Start price updates (CoinGecko doesn't need API key)
        this.startPriceUpdates();
        console.log('💰 Price service initialized with CoinGecko API (free tier)');
    }

    /**
     * Get price for a ticker symbol
     */
    getPrice(ticker) {
        // Clean ticker symbol (remove $ and convert to uppercase)
        const symbol = ticker.replace('$', '').toUpperCase();
        const cached = this.cache.get(symbol);

        if (!cached) return null;

        return {
            symbol: symbol,
            price: cached.price,
            change24h: cached.change24h,
            lastUpdated: cached.lastUpdated,
            formattedPrice: this.formatPrice(cached.price),
            formattedChange: this.formatChange(cached.change24h)
        };
    }

    /**
     * Get all cached prices
     */
    getAllPrices() {
        const prices = {};
        for (const [symbol, data] of this.cache.entries()) {
            prices[symbol] = {
                symbol,
                price: data.price,
                change24h: data.change24h,
                lastUpdated: data.lastUpdated,
                formattedPrice: this.formatPrice(data.price),
                formattedChange: this.formatChange(data.change24h)
            };
        }
        return prices;
    }

    /**
     * Update prices for specific tickers
     */
    async updatePrices(tickers = []) {
        if (this.isUpdating) return;

        this.isUpdating = true;

        try {
            // Clean ticker symbols
            const symbols = tickers
                .map(t => t.replace('$', '').toUpperCase())
                .filter(t => t.length >= 2 && t.length <= 10);

            if (symbols.length === 0) return;

            console.log(`💰 Updating prices for: ${symbols.join(', ')}`);

            // Try CoinGecko first (free tier, no API key needed)
            await this.fetchFromCoinGecko(symbols);

        } catch (error) {
            console.error('❌ Price update error:', error.message);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Fetch prices from CoinGecko (free tier)
     */
    async fetchFromCoinGecko(symbols) {
        try {
            // Map symbols to CoinGecko IDs
            const coingeckoIds = symbols
                .filter(s => this.coingeckoIds[s])
                .map(s => this.coingeckoIds[s]);

            if (coingeckoIds.length === 0) return;

            const response = await axios.get(`${this.providers.coingecko.baseUrl}/simple/price`, {
                params: {
                    ids: coingeckoIds.join(','),
                    vs_currencies: 'usd',
                    include_24hr_change: true
                },
                timeout: 10000
            });

            if (response.data) {
                const now = new Date().toISOString();

                // Map back to symbols
                Object.entries(response.data).forEach(([coingeckoId, data]) => {
                    const symbol = Object.keys(this.coingeckoIds).find(
                        key => this.coingeckoIds[key] === coingeckoId
                    );

                    if (symbol && data.usd) {
                        this.cache.set(symbol, {
                            price: data.usd,
                            change24h: data.usd_24h_change || 0,
                            lastUpdated: now,
                            source: 'coingecko'
                        });
                    }
                });

                console.log(`✅ Updated ${Object.keys(response.data).length} prices from CoinGecko`);
            }
        } catch (error) {
            console.error('❌ CoinGecko API error:', error.message);

            // Fallback to CoinMarketCap if available
            if (this.providers.coinmarketcap.enabled) {
                console.log('🔄 Falling back to CoinMarketCap...');
                await this.fetchFromCoinMarketCap(symbols);
            }
        }
    }

    /**
     * Fallback: Fetch from CoinMarketCap (requires API key)
     */
    async fetchFromCoinMarketCap(symbols) {
        if (!this.providers.coinmarketcap.enabled) return;

        try {
            const response = await axios.get(`${this.providers.coinmarketcap.baseUrl}/cryptocurrency/quotes/latest`, {
                headers: {
                    'X-CMC_PRO_API_KEY': this.providers.coinmarketcap.key,
                    'Accept': 'application/json'
                },
                params: {
                    symbol: symbols.join(','),
                    convert: 'USD'
                },
                timeout: 10000
            });

            if (response.data && response.data.data) {
                const now = new Date().toISOString();

                for (const [symbol, data] of Object.entries(response.data.data)) {
                    if (data && data.quote && data.quote.USD) {
                        const usd = data.quote.USD;
                        this.cache.set(symbol, {
                            price: usd.price,
                            change24h: usd.percent_change_24h,
                            lastUpdated: now,
                            source: 'coinmarketcap'
                        });
                    }
                }

                console.log(`✅ Updated ${Object.keys(response.data.data).length} prices from CoinMarketCap`);
            }
        } catch (error) {
            if (error.response?.status === 429) {
                console.log('⚠️  CoinMarketCap rate limit hit');
            } else {
                console.error('❌ CoinMarketCap API error:', error.message);
            }
        }
    }


    /**
     * Start automatic price updates
     */
    startPriceUpdates() {
        // Update prices every minute for popular coins
        setInterval(async () => {
            const popularTickers = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'UNI', 'AAVE', 'SUSHI'];
            await this.updatePrices(popularTickers);
        }, this.updateInterval);

        console.log('📈 Started automatic price updates (1 minute interval)');
    }

    /**
     * Update prices for AI-suggested tickers
     */
    async updateAISuggestedPrices(aiTickers) {
        if (!aiTickers || aiTickers.length === 0) return;

        // Extract unique tickers and update their prices
        const uniqueTickers = [...new Set(aiTickers.map(t => t.replace('$', '').toUpperCase()))];
        await this.updatePrices(uniqueTickers);
    }

    /**
     * Format price for display
     */
    formatPrice(price) {
        if (!price) return 'N/A';

        if (price >= 1000) {
            return `$${(price / 1000).toFixed(1)}K`;
        } else if (price >= 1) {
            return `$${price.toFixed(2)}`;
        } else if (price >= 0.01) {
            return `$${price.toFixed(4)}`;
        } else {
            return `$${price.toFixed(6)}`;
        }
    }

    /**
     * Format 24h change for display
     */
    formatChange(change) {
        if (!change && change !== 0) return '';

        const sign = change >= 0 ? '+' : '';
        return `${sign}${change.toFixed(2)}%`;
    }

    /**
     * Get price status for dashboard
     */
    getStatus() {
        const providers = Object.entries(this.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        return {
            enabled: providers.length > 0,
            providers: providers,
            cachedCount: this.cache.size,
            isUpdating: this.isUpdating,
            lastUpdate: Array.from(this.cache.values())
                .reduce((latest, item) => {
                    const itemTime = new Date(item.lastUpdated).getTime();
                    return itemTime > latest ? itemTime : latest;
                }, 0)
        };
    }
}

module.exports = PriceService;