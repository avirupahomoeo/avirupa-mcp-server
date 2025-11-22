import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import Redis from "ioredis";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();
app.use(bodyParser.json());

// -------------------- Redis (short-term memory) --------------------
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("error", (err) => {
  console.error("Redis error:", err);
});
redis.on("connect", () => {
  console.log("Redis connected");
});

// -------------------- Supabase (persistent user data) --------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

// -------------------- WooCommerce client --------------------------
const woo = new WooCommerceRestApi({
  url: process.env.WOOCOMERCE_BASE,
  consumerKey: process.env.WOOCONSUMERKEY,
  consumerSecret: process.env.WOOCONSUMERSECRET,
  version: "wc/v3"
});

// -------------------- Utility helpers -----------------------------
async function ensureUserInSupabase(user) {
  // user = { phone, name, email, ... }
  // For demo: table 'users' with unique phone
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("phone", user.phone)
    .limit(1);

  if (error) throw error;

  if (data && data.length) {
    // update
    const upd = await supabase
      .from("users")
      .update(user)
      .eq("phone", user.phone);
    return upd.data?.[0] ?? data[0];
  } else {
    const ins = await supabase.from("users").insert(user).select().single();
    return ins.data;
  }
}

async function getConversationMemory(sessionId) {
  // Short-term memory stored in redis as JSON
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
async function appendConversationMemory(sessionId, messageObj) {
  const mem = await getConversationMemory(sessionId);
  mem.push(messageObj);
  await redis.set(`session:${sessionId}`, JSON.stringify(mem), "EX", 60 * 60 * 12); // 12h TTL
}

// -------------------- Endpoints ----------------------------------

// Health / test
app.get("/", (req, res) => {
  res.send("MCP Server running!");
});

// Example: webhook that WhatsApp provider (Twilio) will POST to
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    // Twilio/other providers vary. Extract phone and message
    const from = req.body.From || req.body.from || (req.body?.messages?.[0]?.from);
    const body = req.body.Body || req.body.text || (req.body?.messages?.[0]?.text?.body);

    // create a simple session id using phone
    const sessionId = from.replace(/\D/g, "");

    // append to memory
    await appendConversationMemory(sessionId, { role: "user", text: body, time: Date.now() });

    // check if message contains personal data (demo)
    if (/my name is (.+)/i.test(body)) {
      const name = body.match(/my name is (.+)/i)[1];
      // store in supabase
      const user = { phone: sessionId, name };
      await ensureUserInSupabase(user);
    }

    // now call model provider or n8n to process message
    // Example: call n8n
    if (process.env.N8N_WEBHOOK_URL) {
      await axios.post(process.env.N8N_WEBHOOK_URL, {
        sessionId, from, body, receivedAt: Date.now()
      }).catch(err => console.error("n8n webhook error", err?.toString()));
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(500).send("ERR");
  }
});

// Minimal endpoints so n8n or others can fetch user data
app.get("/user/:phone", async (req, res) => {
  const phone = req.params.phone;
  const { data, error } = await supabase.from("users").select("*").eq("phone", phone).single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ user: data });
});

// Manual action for testing: push memory to model (example)
app.post("/ask-model", async (req, res) => {
  // req.body: { sessionId, prompt }
  const { sessionId, prompt } = req.body;
  const memory = await getConversationMemory(sessionId);
  // Compose a request for model provider (OpenAI/Gemini/Groq) - placeholder
  // Example: call OpenAI ChatCompletion
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: "no OPENAI_API_KEY" });

  // call OpenAI or another provider here (example uses axios)
  // For now return memory + prompt
  return res.json({ memory, prompt });
});

app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
});
