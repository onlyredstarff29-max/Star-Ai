const DEFAULT_PASS_HASH = "ec754bd024e27421690e1f63924fd80333a9961e99f94d649a188c3344942f8a";

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signToken(secret, payloadObj) {
  const data = btoa(JSON.stringify(payloadObj));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${data}.${sig}`;
}

async function verifyToken(secret, token) {
  if (!token || !token.includes(".")) return false;
  const [data, sig] = token.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = new Uint8Array((sig.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!ok) return false;
  const payload = JSON.parse(atob(data));
  return payload.exp > Date.now();
}

function getSigningSecret(env) {
  return String(env.ADMIN_SECRET || env.ADMIN_PASSWORD || env.GEMINI_API_KEY || DEFAULT_PASS_HASH);
}

function getConfiguredProviders(env) {
  return {
    gemini: Boolean(String(env.GEMINI_API_KEY || "").trim()),
    groq: Boolean(String(env.GROQ_API_KEY || "").trim()),
    openrouter: Boolean(String(env.OPENROUTER_API_KEY || "").trim()),
    cerebras: Boolean(String(env.CEREBRAS_API_KEY || "").trim()),
    mistral: Boolean(String(env.MISTRAL_API_KEY || "").trim()),
  };
}

async function ensureSchema(db) {
  if (!db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_phone TEXT NOT NULL,
      method TEXT NOT NULL,
      trx_id TEXT NOT NULL,
      amount INTEGER DEFAULT 100,
      plan_days INTEGER DEFAULT 7,
      status TEXT DEFAULT 'pending',
      license_key TEXT,
      note TEXT,
      created_at INTEGER,
      approved_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS licenses (
      code TEXT PRIMARY KEY,
      user_phone TEXT,
      days INTEGER DEFAULT 7,
      status TEXT DEFAULT 'active',
      device_id TEXT,
      note TEXT,
      created_at INTEGER,
      expires_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT,
      provider TEXT,
      model TEXT,
      is_fallback INTEGER DEFAULT 0,
      status TEXT,
      latency_ms INTEGER DEFAULT 0,
      error_msg TEXT,
      created_at INTEGER
    )`),
  ]);
}

function generateLicenseCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = (n) => {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return [...arr].map((x) => chars[x % chars.length]).join("");
  };
  return `STAR-${part(4)}-${part(4)}-${part(4)}`;
}

async function testProviderKey(provider, env) {
  const start = Date.now();
  const keys = {
    gemini: String(env.GEMINI_API_KEY || "").trim(),
    groq: String(env.GROQ_API_KEY || "").trim(),
    openrouter: String(env.OPENROUTER_API_KEY || "").trim(),
    cerebras: String(env.CEREBRAS_API_KEY || "").trim(),
    mistral: String(env.MISTRAL_API_KEY || "").trim(),
  };
  const apiKey = keys[provider];
  if (!apiKey) throw new Error("API Key সেট করা নেই");

  let reply = "";
  if (provider === "gemini") {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }] }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    reply = data.candidates?.[0]?.content?.parts?.find((p) => !p.thought)?.text || "OK";
  } else {
    const map = {
      groq: ["https://api.groq.com/openai/v1/chat/completions", "openai/gpt-oss-20b"],
      openrouter: ["https://openrouter.ai/api/v1/chat/completions", "openrouter/free"],
      cerebras: ["https://api.cerebras.ai/v1/chat/completions", "gpt-oss-120b"],
      mistral: ["https://api.mistral.ai/v1/chat/completions", "mistral-small-latest"],
    };
    const [url, model] = map[provider];
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 15,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    reply = data.choices?.[0]?.message?.content || "OK";
  }
  return { ok: true, latencyMs: Date.now() - start, reply: reply.trim().slice(0, 40) };
}

async function authorize(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return verifyToken(getSigningSecret(env), token);
}

export async function onRequestGet(context) {
  try {
    const ok = await authorize(context.request, context.env);
    if (!ok) return Response.json({ error: "অনুমতি নেই (Unauthorized)" }, { status: 401 });

    const db = context.env.DB;
    const providers = getConfiguredProviders(context.env);

    if (!db) {
      return Response.json({
        dbConnected: false,
        providers,
        settings: {},
        stats: { totalReq: 0, freeReq: 0, proReq: 0, pendingPay: 0, revenue: 0, activePro: 0 },
        payments: [],
        licenses: [],
        logs: [],
      });
    }

    await ensureSchema(db);

    const [settingsRes, paymentsRes, licensesRes, logsRes] = await Promise.all([
      db.prepare("SELECT key, value FROM settings").all(),
      db.prepare("SELECT * FROM payments ORDER BY id DESC LIMIT 100").all(),
      db.prepare("SELECT * FROM licenses ORDER BY created_at DESC LIMIT 150").all(),
      db.prepare("SELECT * FROM usage_logs ORDER BY id DESC LIMIT 100").all(),
    ]);

    const settings = {};
    for (const row of settingsRes.results || []) settings[row.key] = row.value;

    const payments = paymentsRes.results || [];
    const licenses = licensesRes.results || [];
    const logs = logsRes.results || [];
    const now = Date.now();

    const stats = {
      totalReq: logs.length,
      freeReq: logs.filter((l) => l.tier === "1.0").length,
      proReq: logs.filter((l) => l.tier === "1.1").length,
      pendingPay: payments.filter((p) => p.status === "pending").length,
      revenue: payments.filter((p) => p.status === "approved").reduce((a, b) => a + (Number(b.amount) || 0), 0),
      activePro: licenses.filter((l) => l.status === "active" && (!l.expires_at || Number(l.expires_at) > now)).length,
    };

    return Response.json({ dbConnected: true, providers, settings, stats, payments, licenses, logs });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { action } = body;

    if (action === "login") {
      const pass = String(body.password || "");
      const envPass = String(context.env.ADMIN_PASSWORD || "").trim();
      const valid = envPass
        ? pass === envPass
        : (await sha256Hex(pass)) === DEFAULT_PASS_HASH;

      if (!valid) {
        return Response.json({ error: "ভুল পাসওয়ার্ড! আবার চেষ্টা করুন।" }, { status: 401 });
      }
      const token = await signToken(getSigningSecret(context.env), {
        role: "master",
        exp: Date.now() + 24 * 60 * 60 * 1000,
      });
      return Response.json({ ok: true, token });
    }

    const ok = await authorize(context.request, context.env);
    if (!ok) return Response.json({ error: "সেশন শেষ হয়েছে, আবার লগইন করুন।" }, { status: 401 });

    if (action === "test_provider") {
      const result = await testProviderKey(body.provider, context.env);
      return Response.json(result);
    }

    const db = context.env.DB;
    if (!db) {
      return Response.json({ error: "Cloudflare D1 Database (DB) Bind করা নেই!" }, { status: 400 });
    }
    await ensureSchema(db);

    if (action === "save_settings") {
      const entries = Object.entries(body.settings || {});
      if (entries.length) {
        await db.batch(
          entries.map(([k, v]) =>
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, String(v ?? ""))
          )
        );
      }
      return Response.json({ ok: true });
    }

    if (action === "generate_license") {
      const days = Math.max(1, Number(body.days || 7));
      const code = generateLicenseCode();
      const now = Date.now();
      const expiresAt = now + days * 24 * 60 * 60 * 1000;
      await db
        .prepare("INSERT INTO licenses (code, user_phone, days, status, note, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
        .bind(code, String(body.phone || "Direct"), days, String(body.note || ""), now, expiresAt)
        .run();
      return Response.json({ ok: true, code });
    }

    if (action === "update_license") {
      const { code, op } = body;
      if (op === "revoke") await db.prepare("UPDATE licenses SET status='revoked' WHERE code=?").bind(code).run();
      else if (op === "activate") await db.prepare("UPDATE licenses SET status='active' WHERE code=?").bind(code).run();
      else if (op === "reset_device") await db.prepare("UPDATE licenses SET device_id=NULL WHERE code=?").bind(code).run();
      else if (op === "extend_7") {
        const row = await db.prepare("SELECT expires_at, days FROM licenses WHERE code=?").bind(code).first();
        const base = Math.max(Date.now(), Number(row?.expires_at || Date.now()));
        await db.prepare("UPDATE licenses SET expires_at=?, days=?, status='active' WHERE code=?")
          .bind(base + 7 * 86400000, Number(row?.days || 7) + 7, code).run();
      }
      else if (op === "delete") await db.prepare("DELETE FROM licenses WHERE code=?").bind(code).run();
      return Response.json({ ok: true });
    }

    if (action === "handle_payment") {
      const { id, op } = body;
      if (op === "delete") {
        await db.prepare("DELETE FROM payments WHERE id=?").bind(id).run();
        return Response.json({ ok: true });
      }
      if (op === "reject") {
        await db.prepare("UPDATE payments SET status='rejected' WHERE id=?").bind(id).run();
        return Response.json({ ok: true });
      }
      if (op === "approve") {
        const pay = await db.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
        if (!pay) throw new Error("পেমেন্ট পাওয়া যায়নি");
        const code = pay.license_key || generateLicenseCode();
        const days = Math.max(1, Number(pay.plan_days || 7));
        const now = Date.now();
        await db.batch([
          db.prepare("INSERT OR IGNORE INTO licenses (code, user_phone, days, status, note, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
            .bind(code, pay.user_phone, days, `${pay.method} ${pay.trx_id}`, now, now + days * 86400000),
          db.prepare("UPDATE payments SET status='approved', license_key=?, approved_at=? WHERE id=?")
            .bind(code, now, id),
        ]);
        return Response.json({ ok: true, license_key: code });
      }
    }

    if (action === "add_manual_payment") {
      const { user_phone, method, trx_id, amount, plan_days, auto_approve } = body;
      if (!user_phone || !trx_id) throw new Error("ফোন নম্বর এবং TrxID দিন");
      const now = Date.now();
      const days = Math.max(1, Number(plan_days || 7));
      let code = null;
      if (auto_approve) {
        code = generateLicenseCode();
        await db.batch([
          db.prepare("INSERT INTO licenses (code, user_phone, days, status, note, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
            .bind(code, user_phone, days, `${method} ${trx_id}`, now, now + days * 86400000),
          db.prepare("INSERT INTO payments (user_phone, method, trx_id, amount, plan_days, status, license_key, created_at, approved_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)")
            .bind(user_phone, method, trx_id, Number(amount || 100), days, code, now, now),
        ]);
      } else {
        await db.prepare("INSERT INTO payments (user_phone, method, trx_id, amount, plan_days, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
          .bind(user_phone, method, trx_id, Number(amount || 100), days, now).run();
      }
      return Response.json({ ok: true, license_key: code });
    }

    if (action === "clear_logs") {
      await db.prepare("DELETE FROM usage_logs").run();
      return Response.json({ ok: true });
    }

    return Response.json({ error: "অজানা অ্যাকশন" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
