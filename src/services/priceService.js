const axios = require('axios');

class PriceService {
    constructor() {
        this.apiKey = process.env.COINMARKETCAP_API_KEY;
        this.baseUrl = 'https://pro-api.coinmarketcap.com/v1';
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

        // Start price updates if API key is available
        if (this.apiKey) {
            this.startPriceUpdates();
            console.log('💰 Price service initialized with CoinMarketCap API');
        } else {
            console.log('⚠️  CoinMarketCap API key not found - price tracking disabled');
        }
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
        if (!this.apiKey || this.isUpdating) return;

        this.isUpdating = true;

        try {
            // Clean ticker symbols
            const symbols = tickers
                .map(t => t.replace('$', '').toUpperCase())
                .filter(t => t.length >= 2 && t.length <= 10);

            if (symbols.length === 0) return;

            console.log(`💰 Updating prices for: ${symbols.join(', ')}`);

            // Separate symbols into those with known IDs and those without
            const symbolsWithIds = symbols.filter(s => this.symbolToId[s]);
            const symbolsWithoutIds = symbols.filter(s => !this.symbolToId[s]);

            // Fetch by IDs first (more reliable)
            if (symbolsWithIds.length > 0) {
                const ids = symbolsWithIds.map(s => this.symbolToId[s]).join(',');
                await this.fetchPricesByIds(ids, symbolsWithIds);
            }

            // Fallback to symbol lookup for unknown tokens
            if (symbolsWithoutIds.length > 0) {
                await this.fetchPricesBySymbols(symbolsWithoutIds);
            }

        } catch (error) {
            console.error('❌ Price update error:', error.message);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Fetch prices using CoinMarketCap IDs (more accurate)
     */
    async fetchPricesByIds(ids, symbols) {
        try {
            const response = await axios.get(`${this.baseUrl}/cryptocurrency/quotes/latest`, {
                headers: {
                    'X-CMC_PRO_API_KEY': this.apiKey,
                    'Accept': 'application/json'
                },
                params: {
                    id: ids,
                    convert: 'USD'
                },
                timeout: 10000
            });

            if (response.data && response.data.data) {
                const now = new Date().toISOString();

                // Map response back to symbols
                Object.values(response.data.data).forEach((data, index) => {
                    if (data && data.quote && data.quote.USD) {
                        const symbol = symbols[index];
                        const usd = data.quote.USD;
                        this.cache.set(symbol, {
                            price: usd.price,
                            change24h: usd.percent_change_24h,
                            lastUpdated: now,
                            name: data.name
                        });
                    }
                });

                console.log(`✅ Updated ${Object.keys(response.data.data).length} prices by ID`);
            }
        } catch (error) {
            console.error('❌ Error fetching prices by ID:', error.message);
        }
    }

    /**
     * Fetch prices using symbol lookup (fallback)
     */
    async fetchPricesBySymbols(symbols) {
        try {
            const response = await axios.get(`${this.baseUrl}/cryptocurrency/quotes/latest`, {
                headers: {
                    'X-CMC_PRO_API_KEY': this.apiKey,
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
                            name: data.name
                        });
                    }
                }

                console.log(`✅ Updated ${Object.keys(response.data.data).length} prices by symbol`);
            }
        } catch (error) {
            if (error.response?.status === 429) {
                console.log('⚠️  CoinMarketCap rate limit hit, backing off');
            } else if (error.response?.status === 401) {
                console.error('❌ CoinMarketCap API key invalid');
            } else {
                console.error('❌ Error fetching prices by symbol:', error.message);
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
        return {
            enabled: Boolean(this.apiKey),
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