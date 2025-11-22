// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');

const app = express();
app.use(bodyParser.json());

// env variables (set in Coolify)
const {
  PORT = 3000,
  MCP_API_KEY,             // your static API key (or use JWT)
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  WOOCONSUMER_KEY,
  WOOCONSUMER_SECRET,
  WOOSHOP_URL,             // https:/avirupahomoeo.com
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  N8N_WEBHOOK_URL,         // https://n8n.avirupahomoeo.com/webhook/...
  REDIS_URL,               // redis://default:pass@redis:6379
  JWT_SECRET = "change_this_to_a_long_secret"
} = process.env;

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Redis client (if REDIS_URL provided)
let redisClient;
if (REDIS_URL) {
  // redis v4
  redisClient = redis.createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error', err));
  redisClient.connect().catch(err => console.error('Redis connect error', err));
}

// local in-memory cache for tiny ephemeral memory
const shortTerm = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour

// Basic API key middleware
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'missing api key' });
  if (key !== MCP_API_KEY) return res.status(403).json({ error: 'invalid key' });
  next();
}

// Health
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Example: get user memory (first check redis, then supabase)
app.get('/user/:phone', requireApiKey, async (req, res) => {
  const phone = req.params.phone;
  try {
    // check redis short-term
    if (redisClient) {
      const cacheKey = `user:${phone}`;
      const cached = await redisClient.get(cacheKey);
      if (cached) return res.json({ source: 'redis', data: JSON.parse(cached) });
    }
    // fallback to Supabase
    const { data, error } = await supabase.from('users').select('*').eq('phone', phone).limit(1).maybeSingle();
    if (error) throw error;
    // store in redis for 5 mins
    if (redisClient && data) {
      await redisClient.setEx(`user:${phone}`, 300, JSON.stringify(data));
    }
    res.json({ source: 'supabase', data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || err });
  }
});

// Example: save or update user profile to Supabase
app.post('/user', requireApiKey, async (req, res) => {
  const payload = req.body; // { phone, name, dob, ... }
  if (!payload || !payload.phone) return res.status(400).json({ error: 'phone required' });
  try {
    // upsert into supabase
    const { data, error } = await supabase.from('users').upsert(payload).select().single();
    if (error) throw error;
    // update redis cache
    if (redisClient) await redisClient.setEx(`user:${payload.phone}`, 300, JSON.stringify(data));
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || err });
  }
});

// Example: call WooCommerce product lookup (basic)
app.get('/wc/product/:id', requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    const url = `${WOOSHOP_URL}/wp-json/wc/v3/products/${id}`;
    const auth = { username: WOOCONSUMER_KEY, password: WOOCONSUMER_SECRET };
    const r = await axios.get(url, { auth });
    res.json(r.data);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || err }); }
});

// Example: trigger a workflow in n8n
app.post('/trigger/n8n', requireApiKey, async (req, res) => {
  try {
    const body = req.body;
    await axios.post(N8N_WEBHOOK_URL, body, { headers: { 'Content-Type': 'application/json' } });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || err }); }
});

// Simple JWT creation (optional) for mobile/clients
app.post('/auth/jwt', requireApiKey, (req, res) => {
  const { sub } = req.body;
  const token = jwt.sign({ sub }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

const port = process.env.PORT || PORT || 3000;
app.listen(port, () => console.log('MCP listening on', port));
