# 🔍 Claude API Cost Analysis & Optimization

## 📊 Token Usage Summary (Sep 19, 2025 - 1 Hour)

### Haiku Usage (claude-3-5-haiku-20241022)
- **Input Tokens**: 1,011,561 tokens
- **Output Tokens**: 13,837 tokens
- **Requests**: 20 calls

### Opus Usage (claude-3-opus-20240229)
- **Input Tokens**: 232,066 tokens
- **Output Tokens**: 17,656 tokens
- **Requests**: 13 calls

---

## 💰 Cost Breakdown (Standard API Pricing)

### Current Pricing (Estimated):
- **Haiku**: $0.25 per 1M input tokens, $1.25 per 1M output tokens
- **Opus**: $15 per 1M input tokens, $75 per 1M output tokens

### Your Hourly Costs:
**Haiku**:
- Input: 1,011,561 × $0.25/1M = **$0.25**
- Output: 13,837 × $1.25/1M = **$0.02**
- **Total Haiku**: $0.27

**Opus**:
- Input: 232,066 × $15/1M = **$3.48**
- Output: 17,656 × $75/1M = **$1.32**
- **Total Opus**: $4.80

### **Hourly Total: $5.07**
### **Daily Estimate: $121.68**
### **Monthly Estimate: $3,650**

---

## 🚨 Critical Optimization Opportunities

### 1. **Haiku is Overused for Decisions**
**Issue**: Haiku uses 1M+ tokens/hour for simple yes/no decisions
**Fix**: Reduce context size for Haiku calls

```js
// Current (BAD): Sending full tweet context to Haiku
const text = this.formatTweetsForPrompt(tweets); // 50k+ tokens

// Optimized (GOOD): Send only essential info
const essentialContext = tweets.slice(0, 10).map(t =>
    `@${t.username}: ${t.text.slice(0, 200)}`
).join('\n'); // ~2k tokens
```

### 2. **Opus Called Too Frequently**
**Issue**: 13 Opus calls/hour = $115/day
**Fix**: Increase cooldown and use smarter triggering

```js
// Current: Runs every few minutes
this.opusIntervalMs = 5 * 60 * 1000; // 5 minutes

// Optimized: Run only on significant changes
this.opusIntervalMs = 15 * 60 * 1000; // 15 minutes
// + Only trigger on >3 new tweets or major market events
```

### 3. **Token Waste in Prompts**
**Issue**: Sending duplicate data and verbose prompts
**Fix**: Optimize prompt structure

---

## 🎯 Immediate Cost Reduction Strategy

### Phase 1: Quick Wins (50% cost reduction)
1. **Reduce Haiku Context**:
   - Current: ~50k tokens → Target: ~5k tokens
   - **Savings**: $0.20/hour = $144/month

2. **Increase Opus Cooldown**:
   - Current: Every 5min → Target: Every 15min
   - **Savings**: $3.20/hour = $2,300/month

3. **Smart Haiku Filtering**:
   - Only run Haiku if >2 new tweets
   - **Savings**: $0.15/hour = $108/month

### Phase 2: Advanced Optimizations (70% cost reduction)
1. **Context Caching**: Use Claude's prompt caching
2. **Batch Processing**: Group decisions together
3. **Smart Triggers**: Only analyze when markets are active

---

## 🛠️ Implementation Plan

### Step 1: Reduce Token Usage (Immediate)
```js
// In AIService.js - Optimize Haiku context
formatTweetsForPrompt(tweets, maxTokens = 5000) {
    // Truncate tweets to fit token budget
    let context = '';
    let tokenCount = 0;

    for (const tweet of tweets.slice(0, 15)) {
        const tweetText = `@${tweet.username}: ${tweet.text.slice(0, 150)}\n`;
        if (tokenCount + tweetText.length > maxTokens) break;
        context += tweetText;
        tokenCount += tweetText.length;
    }
    return context;
}
```

### Step 2: Smarter Opus Triggering
```js
// Only run Opus on significant changes
async shouldRunOpusAnalysis(tweets) {
    const newTweetCount = tweets.filter(t =>
        Date.now() - new Date(t.created_at) < 10 * 60 * 1000
    ).length;

    const lastOpusAge = Date.now() - this.state.lastOpusAt;
    const minInterval = 15 * 60 * 1000; // 15 minutes

    // Only run if: enough time passed AND significant activity
    return lastOpusAge > minInterval && newTweetCount >= 3;
}
```

### Step 3: Budget Controls
```js
// Add daily budget limits
class AIService {
    constructor() {
        this.dailyBudget = 50; // $50/day limit
        this.dailySpend = 0;
        this.resetDaily();
    }

    async checkBudget(estimatedCost) {
        if (this.dailySpend + estimatedCost > this.dailyBudget) {
            console.log('🚫 Daily budget exceeded, skipping AI analysis');
            return false;
        }
        return true;
    }
}
```

---

## 📈 Expected Results

### Before Optimization:
- **Daily Cost**: $121.68
- **Monthly Cost**: $3,650
- **Calls/Hour**: 33 (20 Haiku + 13 Opus)

### After Optimization:
- **Daily Cost**: $36.50 (70% reduction)
- **Monthly Cost**: $1,095 (70% reduction)
- **Calls/Hour**: 12 (8 Haiku + 4 Opus)

### **Total Savings**: $2,555/month 🎉

---

## 🔧 Quick Implementation Checklist

- [ ] Reduce Haiku context from 50k to 5k tokens
- [ ] Increase Opus interval from 5min to 15min
- [ ] Add token counting to all prompts
- [ ] Implement daily budget limits
- [ ] Add smart filtering (only analyze with >2 new tweets)
- [ ] Cache common responses
- [ ] Monitor costs with new tracking system

**Priority**: Implement Steps 1-2 immediately for 50% cost reduction!