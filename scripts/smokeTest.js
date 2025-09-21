#!/usr/bin/env node
/*
  Smoke test for Live Alpha Tracker
  - Boots server on an available port
  - Pings /health, /api/ai/status, /api/ai/budget
  - Inserts a test tweet and checks it appears in /api/tweets/live
  - Sends a test AI insight to Discord (if DISCORD_WEBHOOK_URL is set)
*/

require('dotenv').config();

(async () => {
  const { AlphaTrackerServer } = require('../src/server');
  const { getPool } = require('../src/config/database');

  const results = { ok: true, steps: [] };
  const record = (name, ok, info = '') => {
    results.steps.push({ name, ok, info });
    if (!ok) results.ok = false;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${name}${info ? ' - ' + info : ''}`);
  };

  let serverInstance;
  let baseUrl = '';
  try {
    serverInstance = new AlphaTrackerServer();
    const port = await serverInstance.start();
    baseUrl = `http://localhost:${port}`;
    record('Server started', true, baseUrl);
  } catch (e) {
    record('Server start failed', false, e.message || String(e));
    process.exit(1);
  }

  // Small helper for fetch with timeout
  const fetchJson = async (url, opts = {}, timeoutMs = 5000) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(to);
    }
  };

  // 1) Health
  try {
    const r = await fetchJson(`${baseUrl}/health`);
    record('GET /health', r.ok, `status=${r.status}`);
  } catch (e) {
    record('GET /health', false, e.message || String(e));
  }

  // 2) AI Status
  try {
    const r = await fetchJson(`${baseUrl}/api/ai/status`);
    record('GET /api/ai/status', r.ok, `phase=${r.data?.phase}`);
  } catch (e) {
    record('GET /api/ai/status', false, e.message || String(e));
  }

  // 3) AI Budget
  try {
    const r = await fetchJson(`${baseUrl}/api/ai/budget`);
    record('GET /api/ai/budget', r.ok, `dailyCost=${r.data?.daily?.totalSpend}`);
  } catch (e) {
    record('GET /api/ai/budget', false, e.message || String(e));
  }

  // 4) Insert a test tweet and verify it appears
  try {
    const pool = getPool();
    const nowMs = Date.now();
    const testId = String(nowMs);
    const username = 'alpha_smoke_test';
    await pool.execute(
      `INSERT INTO cz_tweets (id, text, created_at, created_at_ms, like_count, retweet_count, reply_count, quote_count, impression_count, url, username)
       VALUES (?, ?, FROM_UNIXTIME(?/1000), ?, 0,0,0,0,0, ?, ?)
       ON DUPLICATE KEY UPDATE text = VALUES(text)`,
      [
        testId,
        '[SMOKE] This is a test tweet from smokeTest.js',
        nowMs,
        nowMs,
        `https://twitter.com/${username}/status/${testId}`,
        username
      ]
    );
    const r = await fetchJson(`${baseUrl}/api/tweets/live`);
    const found = Array.isArray(r.data) && r.data.some(t => String(t.id) === testId);
    record('Insert & fetch test tweet', r.ok && found, found ? 'present in live feed' : 'not found');
  } catch (e) {
    record('Insert & fetch test tweet', false, e.message || String(e));
  }

  // 5) Discord AI insight test (optional)
  try {
    if (process.env.DISCORD_WEBHOOK_URL) {
      await serverInstance.notifier.notifyAIInsights({ headline: '[TEST] AI smoke insight', tickers: ['$TEST'] });
      record('Discord AI insight', true, 'sent');
    } else {
      record('Discord AI insight', true, 'skipped (no DISCORD_WEBHOOK_URL)');
    }
  } catch (e) {
    record('Discord AI insight', false, e.message || String(e));
  }

  // Shutdown
  try {
    serverInstance.tracker.stop();
    serverInstance.server.close();
  } catch {}

  console.log('\n=== Smoke Test Summary ===');
  results.steps.forEach(s => console.log(`${s.ok ? '✅' : '❌'} ${s.name} ${s.info ? '- ' + s.info : ''}`));
  process.exit(results.ok ? 0 : 1);
})();


