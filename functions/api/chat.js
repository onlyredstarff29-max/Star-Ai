const FREE_FALLBACK_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6" },
  { provider: "cerebras", model: "gpt-oss-120b", label: "Cerebras 120B" },
  { provider: "openrouter", model: "openrouter/free", label: "OpenRouter Free" },
  { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Lite" },
  { provider: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
  { provider: "gemini", model: "gemma-4-31b-it", label: "Gemma 4 31B" },
  { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small" },
  { provider: "cerebras", model: "qwen-3-235b-a22b-instruct-2507", label: "Qwen 235B" },
  { provider: "openrouter", model: "google/gemma-3-27b-it:free", label: "Gemma 3 27B" },
  { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8" },
  { provider: "groq", model: "qwen/qwen3.8-27b", label: "Qwen 3.8" },
];

async function ensureSchema(db) {
  if (!db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT NOT NULL, method TEXT NOT NULL,
      trx_id TEXT NOT NULL, amount INTEGER DEFAULT 100, plan_days INTEGER DEFAULT 7,
      status TEXT DEFAULT 'pending', license_key TEXT, note TEXT, created_at INTEGER, approved_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS licenses (
      code TEXT PRIMARY KEY, user_phone TEXT, days INTEGER DEFAULT 7, status TEXT DEFAULT 'active',
      device_id TEXT, note TEXT, created_at INTEGER, expires_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT, provider TEXT, model TEXT,
      is_fallback INTEGER DEFAULT 0, status TEXT, latency_ms INTEGER DEFAULT 0, error_msg TEXT, created_at INTEGER
    )`),
  ]);
}

async function loadSettings(db) {
  const s = {};
  if (!db) return s;
  await ensureSchema(db);
  const res = await db.prepare("SELECT key, value FROM settings").all();
  for (const row of res.results || []) s[row.key] = row.value;
  return s;
}

function getKeys(env) {
  return {
    gemini: String(env.GEMINI_API_KEY || "").trim(),
    groq: String(env.GROQ_API_KEY || "").trim(),
    openrouter: String(env.OPENROUTER_API_KEY || "").trim(),
    cerebras: String(env.CEREBRAS_API_KEY || "").trim(),
    mistral: String(env.MISTRAL_API_KEY || "").trim(),
  };
}

async function verifyLicense(db, code, deviceId) {
  if (!db || !code) return { active: false };
  const row = await db.prepare("SELECT * FROM licenses WHERE code=?").bind(code.trim().toUpperCase()).first();
  if (!row || row.status !== "active") return { active: false };
  if (row.expires_at && Number(row.expires_at) < Date.now()) return { active: false };
  if (row.device_id && deviceId && row.device_id !== deviceId) return { active: false };
  return { active: true, expiresAt: Number(row.expires_at || 0), days: row.days };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const db = context.env.DB;
    const s = await loadSettings(db);
    const keys = getKeys(context.env);
    const proStatus = await verifyLicense(db, url.searchParams.get("license_code"), url.searchParams.get("device_id"));

    return Response.json({
      providers: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, Boolean(v)])),
      proStatus,
      config: {
        site_name: s.site_name || "Star AI",
        welcome_title: s.welcome_title || "Star AI-তে স্বাগতম",
        welcome_sub: s.welcome_sub || "বাংলা, Banglish ও বিশ্বের যেকোনো ভাষায় প্রশ্ন করুন।",
        notice_enabled: s.notice_enabled === "1",
        notice_text: s.notice_text || "",
        maintenance_mode: s.maintenance_mode === "1",
        maintenance_msg: s.maintenance_msg || "সাইট আপডেট চলছে।",
        free_daily_limit: Number(s.free_daily_limit ?? 30),
        pro_price: Number(s.pro_price ?? 100),
        pro_days: Number(s.pro_days ?? 7),
        bkash_enabled: s.bkash_enabled !== "0",
        bkash_number: s.bkash_number || "01999928788",
        bkash_type: s.bkash_type || "Send Money",
        nagad_enabled: s.nagad_enabled !== "0",
        nagad_number: s.nagad_number || "01999928788",
        nagad_type: s.nagad_type || "Send Money",
        payment_note: s.payment_note || "bKash বা Nagad থেকে টাকা পাঠিয়ে নিচে আপনার নম্বর এবং TrxID দিন।",
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function buildPrompt(base, langMode) {
  const rules = {
    auto: "Detect user's language automatically. Understand Bengali, Banglish (Romanized Bengali), English, Hindi, Arabic, and ALL world languages accurately without complaining about spelling.",
    bn: "Always reply in clear, natural Bengali (বাংলা).",
    banglish: "Always reply in friendly Banglish (Bengali in English alphabet).",
    en: "Always reply in clear, natural English.",
    hi: "Always reply in clear, natural Hindi.",
    ar: "Always reply in clear, natural Arabic.",
  };
  return `${base}\n\nLANGUAGE RULES:\n- ${rules[langMode] || rules.auto}\n- Format answers cleanly with Markdown and code blocks.`;
}

function normalizeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const content = String(m?.content || "").trim();
    if (!content) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role, content });
  }
  return out;
}

function buildCandidates(tier, settings, keys) {
  let provCfg = {};
  try { provCfg = JSON.parse(settings.provider_config || "{}"); } catch {}

  let list = [...FREE_FALLBACK_CHAIN].filter((c) => {
    if (!keys[c.provider]) return false;
    return provCfg[c.provider]?.enabled !== false;
  });

  list.sort((a, b) => (provCfg[a.provider]?.priority ?? 5) - (provCfg[b.provider]?.priority ?? 5));

  if (tier === "1.1" && settings.pro_model && settings.pro_model.includes("::")) {
    const [p, m] = settings.pro_model.split("::");
    if (keys[p]) {
      list = list.filter((c) => !(c.provider === p && c.model === m));
      list.unshift({ provider: p, model: m, label: `${p.toUpperCase()} Pro` });
    }
  }
  return list;
}

function extractToken(provider, json) {
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  if (provider === "gemini") {
    return (json.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  }
  return json.choices?.[0]?.delta?.content || "";
}

async function openUpstream(candidate, apiKey, messages, sysPrompt) {
  const { provider, model } = candidate;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 14000);

  try {
    let res;
    if (provider === "gemini") {
      const isGemma = model.startsWith("gemma-");
      const contents = messages.map((m, i) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: isGemma && i === 0 && m.role === "user" ? `[System:\n${sysPrompt}]\n\n${m.content}` : m.content }],
      }));
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(isGemma ? { contents } : { systemInstruction: { parts: [{ text: sysPrompt }] }, contents }),
        }
      );
    } else {
      const urls = {
        groq: "https://api.groq.com/openai/v1/chat/completions",
        openrouter: "https://openrouter.ai/api/v1/chat/completions",
        cerebras: "https://api.cerebras.ai/v1/chat/completions",
        mistral: "https://api.mistral.ai/v1/chat/completions",
      };
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://star-ai.pages.dev";
        headers["X-Title"] = "Star AI";
      }
      res = await fetch(urls[provider], {
        method: "POST",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({ model, messages: [{ role: "system", content: sysPrompt }, ...messages], stream: true }),
      });
    }

    if (!res.ok) throw new Error(`${provider} ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstText = "";

    const parseChunkLines = (lines) => {
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try { firstText += extractToken(provider, JSON.parse(d)); } catch (e) {
          if (!e.message.includes("JSON")) throw e;
        }
      }
    };

    while (!firstText) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) parseChunkLines(buffer.split("\n"));
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      parseChunkLines(lines);
    }

    clearTimeout(timer);
    if (!firstText) throw new Error("Empty response");
    return { firstText, reader, decoder, buffer, candidate };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const action = body.action || "chat";
    const db = context.env.DB;

    if (action === "submit_payment") {
      if (!db) return Response.json({ error: "D1 Database (DB) সেটআপ করা নেই।" }, { status: 400 });
      await ensureSchema(db);
      const phone = String(body.user_phone || "").trim();
      const trx = String(body.trx_id || "").trim();
      const method = body.method === "nagad" ? "nagad" : "bkash";
      if (phone.length < 11 || trx.length < 4) {
        return Response.json({ error: "সঠিক ফোন নম্বর এবং TrxID দিন।" }, { status: 400 });
      }
      const dup = await db.prepare("SELECT id FROM payments WHERE trx_id=?").bind(trx).first();
      if (dup) return Response.json({ error: "এই TrxID ইতিমধ্যেই সাবমিট করা হয়েছে!" }, { status: 400 });

      await db.prepare(
        "INSERT INTO payments (user_phone, method, trx_id, amount, plan_days, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      ).bind(phone, method, trx, Number(body.amount || 100), Number(body.plan_days || 7), Date.now()).run();
      return Response.json({ ok: true });
    }

    if (action === "check_payment") {
      if (!db) return Response.json({ status: "pending" });
      await ensureSchema(db);
      const row = await db.prepare("SELECT status, license_key FROM payments WHERE trx_id=?").bind(String(body.trx_id || "").trim()).first();
      return Response.json({ status: row?.status || "pending", license_key: row?.license_key || null });
    }

    if (action === "activate_license") {
      if (!db) return Response.json({ error: "D1 Database (DB) সেটআপ করা নেই।" }, { status: 400 });
      await ensureSchema(db);
      const code = String(body.code || "").trim().toUpperCase();
      const devId = String(body.device_id || "").trim();
      const row = await db.prepare("SELECT * FROM licenses WHERE code=?").bind(code).first();
      if (!row) return Response.json({ error: "ভুল Pro কোড!" }, { status: 404 });
      if (row.status !== "active") return Response.json({ error: "এই কোডটি বন্ধ (Revoked) করা হয়েছে।" }, { status: 403 });
      if (row.expires_at && Number(row.expires_at) < Date.now()) {
        return Response.json({ error: "এই কোডের মেয়াদ শেষ হয়ে গেছে!" }, { status: 403 });
      }
      if (row.device_id && devId && row.device_id !== devId) {
        return Response.json({ error: "এই কোডটি ইতিমধ্যে অন্য ডিভাইসে ব্যবহৃত হচ্ছে!" }, { status: 403 });
      }
      if (!row.device_id && devId) {
        await db.prepare("UPDATE licenses SET device_id=? WHERE code=?").bind(devId, code).run();
      }
      return Response.json({ ok: true, code: row.code, expires_at: Number(row.expires_at), days: row.days });
    }

    // Normal Chat Request
    const startTime = Date.now();
    const s = await loadSettings(db);
    if (s.maintenance_mode === "1") {
      return Response.json({ error: s.maintenance_msg || "সাইট রক্ষণাবেক্ষণ চলছে।" }, { status: 503 });
    }

    const cleanMessages = normalizeMessages(body.messages);
    if (!cleanMessages.length) return Response.json({ error: "মেসেজ লিখুন।" }, { status: 400 });

    if (s.blocked_words) {
      const lastTxt = cleanMessages[cleanMessages.length - 1].content.toLowerCase();
      const blocked = s.blocked_words.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (blocked.some((w) => lastTxt.includes(w))) {
        return Response.json({ error: "দুঃখিত, এই ধরনের শব্দ গ্রহণযোগ্য নয়।" }, { status: 400 });
      }
    }

    let tier = "1.0";
    if (body.tier === "1.1") {
      const proCheck = await verifyLicense(db, body.licenseCode, body.deviceId);
      if (!proCheck.active) {
        return Response.json({ error: "Star AI 1.1 Pro আনলক করা নেই বা মেয়াদ শেষ হয়েছে।", proRequired: true }, { status: 403 });
      }
      tier = "1.1";
    }

    const keys = getKeys(context.env);
    const candidates = buildCandidates(tier, s, keys);
    if (!candidates.length) {
      return Response.json({ error: "কোনো সচল API Key পাওয়া যায়নি।" }, { status: 400 });
    }

    const basePrompt = tier === "1.1"
      ? (s.pro_system_prompt || "You are Star AI 1.1 Pro, an expert senior developer & researcher.")
      : (s.free_system_prompt || "You are Star AI 1.0, a smart helpful assistant.");
    const fullPrompt = buildPrompt(basePrompt, body.langMode || "auto");

    let active = null;
    const errors = [];
    for (let i = 0; i < candidates.length; i++) {
      try {
        active = await openUpstream(candidates[i], keys[candidates[i].provider], cleanMessages, fullPrompt);
        active.isFallback = i > 0;
        break;
      } catch (err) {
        errors.push(`${candidates[i].label}: ${err.message}`);
      }
    }

    const latency = Date.now() - startTime;
    if (!active) {
      if (db) {
        context.waitUntil(
          db.prepare("INSERT INTO usage_logs (tier, provider, model, is_fallback, status, latency_ms, error_msg, created_at) VALUES (?, ?, ?, 1, 'error', ?, ?, ?)")
            .bind(tier, "all", "fallback", latency, errors.join(" | ").slice(0, 200), Date.now()).run()
        );
      }
      return Response.json({ error: `সব ফ্রি API ব্যস্ত আছে (${errors[0] || "Error"})` }, { status: 502 });
    }

    if (db) {
      context.waitUntil(
        db.prepare("INSERT INTO usage_logs (tier, provider, model, is_fallback, status, latency_ms, error_msg, created_at) VALUES (?, ?, ?, ?, 'ok', ?, '', ?)")
          .bind(tier, active.candidate.provider, active.candidate.model, active.isFallback ? 1 : 0, latency, Date.now()).run()
      );
    }

    const { firstText, reader, decoder, buffer: initBuf, candidate, isFallback } = active;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          meta: { tier, provider: candidate.provider, label: candidate.label, fallback: isFallback },
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: firstText })}\n\n`));

        let buffer = initBuf;
        const pushLine = (raw) => {
          const t = raw.trim();
          if (!t.startsWith("data:")) return;
          const d = t.slice(5).trim();
          if (!d || d === "[DONE]") return;
          try {
            const tok = extractToken(candidate.provider, JSON.parse(d));
            if (tok) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: tok })}\n\n`));
          } catch {}
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            lines.forEach(pushLine);
          }
          if (buffer.trim()) pushLine(buffer);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) { controller.error(err); }
      },
    });

    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
