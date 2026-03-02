const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('.'));

// Rate limiting configuration per user email
const RATE_LIMITS = {
  // Full admin access - 100 requests/day
  'aeubanks@brushworx.com': 100,
  'brushworxok@gmail.com': 100,
  'just4jordan@yahoo.com': 100,
  'cm22construction@gmail.com': 100,
  'jade.gilbert@rpmliving.com': 100,
  
  // Brushworx workers - 20 requests/day
  'BRUSHWORX_WORKER': 20,
  
  // External stakeholders - 10 requests/day
  'jeffrey.cohen@greyco.com': 10,
  'DEFAULT': 10
};

// Cost tracking storage (in production, use Redis or database)
const usageTracking = new Map();
const dailyBudgetLimit = parseFloat(process.env.DAILY_BUDGET_LIMIT || '50');
let totalDailyCost = 0;
let lastResetDate = new Date().toDateString();

// Reset daily counters
function resetDailyCounters() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    console.log(`📊 Daily reset - Previous day cost: $${totalDailyCost.toFixed(2)}`);
    totalDailyCost = 0;
    lastResetDate = today;
    usageTracking.clear();
  }
}

// Calculate token cost (Claude Sonnet 4 pricing)
function calculateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000000) * 3;
  const outputCost = (outputTokens / 1000000) * 15;
  return inputCost + outputCost;
}

// Get user rate limit
function getUserLimit(userEmail) {
  if (!userEmail) return RATE_LIMITS.DEFAULT;
  
  const email = userEmail.toLowerCase();
  if (RATE_LIMITS[email]) return RATE_LIMITS[email];
  
  // Check if Brushworx worker
  if (email.includes('brushworx') && !RATE_LIMITS[email]) {
    return RATE_LIMITS.BRUSHWORX_WORKER;
  }
  
  return RATE_LIMITS.DEFAULT;
}

// Track usage
function trackUsage(userEmail) {
  resetDailyCounters();
  
  if (!usageTracking.has(userEmail)) {
    usageTracking.set(userEmail, { count: 0, cost: 0 });
  }
  
  const usage = usageTracking.get(userEmail);
  usage.count += 1;
  usageTracking.set(userEmail, usage);
  
  return usage;
}

// Check if user has exceeded rate limit
function checkRateLimit(userEmail) {
  resetDailyCounters();
  
  const usage = usageTracking.get(userEmail) || { count: 0, cost: 0 };
  const limit = getUserLimit(userEmail);
  
  return {
    allowed: usage.count < limit,
    current: usage.count,
    limit: limit,
    remaining: Math.max(0, limit - usage.count)
  };
}

// Emergency kill switch
app.get('/api/emergency-stop', (req, res) => {
  const apiKey = req.headers['x-admin-key'];
  if (apiKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  process.env.AI_DISABLED = 'true';
  res.json({ 
    success: true, 
    message: 'AI features disabled. Restart server to re-enable.' 
  });
});

// Usage dashboard endpoint
app.get('/api/usage', (req, res) => {
  const apiKey = req.headers['x-admin-key'];
  if (apiKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  resetDailyCounters();
  
  const stats = {
    date: new Date().toISOString(),
    totalDailyCost: totalDailyCost,
    budgetLimit: dailyBudgetLimit,
    budgetRemaining: Math.max(0, dailyBudgetLimit - totalDailyCost),
    users: []
  };
  
  for (const [email, data] of usageTracking.entries()) {
    stats.users.push({
      email,
      requests: data.count,
      cost: data.cost,
      limit: getUserLimit(email),
      remaining: Math.max(0, getUserLimit(email) - data.count)
    });
  }
  
  res.json(stats);
});

// Main AI chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    // Check if AI is disabled
    if (process.env.AI_DISABLED === 'true') {
      return res.status(503).json({ 
        error: 'AI features temporarily disabled for cost management' 
      });
    }
    
    // Get user email from request
    const userEmail = req.body.userEmail || req.headers['x-user-email'] || 'anonymous';
    
    // Check rate limit
    const rateLimitStatus = checkRateLimit(userEmail);
    if (!rateLimitStatus.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: rateLimitStatus.limit,
        current: rateLimitStatus.current,
        message: `You have reached your daily limit of ${rateLimitStatus.limit} AI requests. Limit resets at midnight.`
      });
    }
    
    // Check daily budget
    if (totalDailyCost >= dailyBudgetLimit) {
      console.warn(`⚠️ Daily budget limit reached: $${totalDailyCost.toFixed(2)}`);
      return res.status(429).json({
        error: 'Daily budget limit reached',
        message: 'AI features paused for today due to budget limits. Resets at midnight.'
      });
    }
    
    // Validate API key exists
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY not set in environment variables');
      return res.status(500).json({ 
        error: 'Server configuration error - API key not configured' 
      });
    }
    
    // Track usage
    trackUsage(userEmail);
    
    // Make request to Anthropic API
    const startTime = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || 'claude-sonnet-4-20250514',
        max_tokens: req.body.max_tokens || 4000,
        system: req.body.system || '',
        messages: req.body.messages || []
      })
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ Anthropic API Error ${response.status}:`, errorBody.substring(0, 200));
      return res.status(response.status).json({ 
        error: `API Error ${response.status}`,
        details: errorBody.substring(0, 100)
      });
    }
    
    const data = await response.json();
    
    // Calculate and track cost
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cost = calculateCost(inputTokens, outputTokens);
    
    totalDailyCost += cost;
    
    const usage = usageTracking.get(userEmail);
    usage.cost += cost;
    usageTracking.set(userEmail, usage);
    
    // Log request for monitoring
    console.log(`✅ AI Request: ${userEmail} | Tokens: ${inputTokens}→${outputTokens} | Cost: $${cost.toFixed(4)} | Time: ${responseTime}ms | Daily Total: $${totalDailyCost.toFixed(2)}`);
    
    // Check budget thresholds and warn
    const budgetPercent = (totalDailyCost / dailyBudgetLimit) * 100;
    if (budgetPercent >= 80 && budgetPercent < 100) {
      console.warn(`⚠️ WARNING: Daily budget at ${budgetPercent.toFixed(1)}% ($${totalDailyCost.toFixed(2)}/${dailyBudgetLimit})`);
    }
    
    // Add usage metadata to response
    res.json({
      ...data,
      usage_info: {
        requests_remaining: rateLimitStatus.remaining - 1,
        daily_limit: rateLimitStatus.limit,
        cost: cost,
        daily_cost: totalDailyCost,
        budget_remaining: Math.max(0, dailyBudgetLimit - totalDailyCost)
      }
    });
    
  } catch (error) {
    console.error('❌ Server Error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    ai_enabled: process.env.AI_DISABLED !== 'true',
    daily_cost: totalDailyCost,
    budget_limit: dailyBudgetLimit,
    api_configured: !!process.env.ANTHROPIC_API_KEY
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         🏗️  ALORA PROPERTY TRACKER - SERVER READY        ║
╚══════════════════════════════════════════════════════════╝

🚀 Server running on port ${PORT}
🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? '✅ Configured' : '❌ MISSING'}
💰 Daily Budget: $${dailyBudgetLimit}
📊 Rate Limits:
   - Admins (Anthony, Curtis, Jade): 100/day
   - Brushworx Workers: 20/day
   - External Users: 10/day

🌐 Endpoints:
   POST /api/chat          - AI chat (rate limited)
   GET  /api/usage         - Usage dashboard (admin only)
   GET  /api/health        - Health check
   GET  /api/emergency-stop - Emergency AI disable (admin only)

Ready to serve! 🎯
  `);
});
