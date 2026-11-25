const FALLBACK_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b", label: "Groq GPT-OSS 120B" },
  { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { provider: "cerebras", model: "gpt-oss-120b", label: "Cerebras GPT-OSS 120B" },
  { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { provider: "groq", model: "openai/gpt-oss-20b", label: "Groq GPT-OSS 20B" },
  { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Lite" },
  { provider: "openrouter", model: "openrouter/free", label: "OpenRouter Free" },
  { provider: "gemini", model: "gemma-4-31b-it", label: "Gemma 4 31B" },
  { provider: "cerebras", model: "qwen-3-235b-a22b-instruct-2507", label: "Cerebras Qwen 235B" },
  { provider: "openrouter", model: "google/gemma-3-27b-it:free", label: "OpenRouter Gemma 3" },
  { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small" },
  { provider: "gemini", model: "gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
  { provider: "groq", model: "qwen/qwen3.8-27b", label: "Groq Qwen 3.8" },
  { provider: "openrouter", model: "qwen/qwen3-coder:free", label: "OpenRouter Qwen3 Coder" },
];

export async function onRequestGet(context) {
  return Response.json({
    providers: {
      gemini: Boolean(context.env.GEMINI_API_KEY),
      groq: Boolean(context.env.GROQ_API_KEY),
      openrouter: Boolean(context.env.OPENROUTER_API_KEY),
      cerebras: Boolean(context.env.CEREBRAS_API_KEY),
      mistral: Boolean(context.env.MISTRAL_API_KEY),
    },
  });
}

function buildMultilingualPrompt(basePrompt, langMode) {
  const langRuleMap = {
    auto: "Detect the user's language automatically. If they write in Bengali (বাংলা), reply in natural Bengali. If they write in Banglish (Bengali written in English letters like 'kemon acho', 'bhai code daw'), understand it 100% accurately and reply in friendly Bengali (or Banglish if requested). For English, Hindi, Arabic, Urdu, or ANY other world language, reply fluently in that exact language.",
    bn: "Always reply in clear, natural, polite Bengali (বাংলা), regardless of whether the user writes in Bengali, Banglish, or another language.",
    banglish: "Always reply in friendly Banglish (Bengali written using English alphabet, e.g., 'Ami valo achi, apni kemon achen?').",
    en: "Always reply in clear, natural English.",
    hi: "Always reply in clear, natural Hindi (हिन्दी).",
    ar: "Always reply in clear, natural Arabic (العربية).",
  };

  return `${basePrompt}

UNIVERSAL LANGUAGE & ACCURACY RULES:
- ${langRuleMap[langMode] || langRuleMap.auto}
- NEVER complain about spelling, grammar, or Romanized Bengali (Banglish). Understand the user's exact words and intent without altering their meaning.
- Use clean Markdown and properly tagged code blocks when sharing code.`;
}

function normalizeMessages(messages) {
  const cleaned = [];
  for (const m of messages || []) {
    const content = String(m?.content || "").trim();
    if (!content) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (cleaned.length && cleaned[cleaned.length - 1].role === role) {
      cleaned[cleaned.length - 1].content += "\n\n" + content;
    } else {
      cleaned.push({ role, content });
    }
  }
  return cleaned;
}

function buildCandidateList(selected, keys) {
  let candidates = [...FALLBACK_CHAIN];
  if (selected && selected !== "auto" && selected.includes("::")) {
    const [provider, model] = selected.split("::");
    const idx = candidates.findIndex((c) => c.provider === provider && c.model === model);
    if (idx > -1) {
      const [picked] = candidates.splice(idx, 1);
      candidates.unshift(picked);
    } else {
      candidates.unshift({ provider, model, label: `${provider.toUpperCase()} ${model}` });
    }
  }
  return candidates.filter((c) => Boolean(keys[c.provider]));
}

function extractToken(provider, json) {
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }
  if (provider === "gemini") {
    const parts = json.candidates?.[0]?.content?.parts || [];
    return parts
      .filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join("");
  }
  return json.choices?.[0]?.delta?.content || "";
}

async function openUpstream(candidate, apiKey, messages, fullSystemPrompt) {
  const { provider, model } = candidate;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 14000);

  let res;
  try {
    if (provider === "gemini") {
      const isGemma = model.startsWith("gemma-");
      const contents = messages.map((m, idx) => {
        let text = m.content;
        if (isGemma && idx === 0 && m.role === "user") {
          text = `[System Instructions:\n${fullSystemPrompt}]\n\nUser: ${text}`;
        }
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text }],
        };
      });

      const payload = isGemma
        ? { contents }
        : { systemInstruction: { parts: [{ text: fullSystemPrompt }] }, contents };

      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(payload),
        }
      );
    } else {
      const endpoints = {
        groq: "https://api.groq.com/openai/v1/chat/completions",
        openrouter: "https://openrouter.ai/api/v1/chat/completions",
        cerebras: "https://api.cerebras.ai/v1/chat/completions",
        mistral: "https://api.mistral.ai/v1/chat/completions",
      };

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://star-ai.pages.dev";
        headers["X-Title"] = "Star AI";
      }

      res = await fetch(endpoints[provider], {
        method: "POST",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: fullSystemPrompt }, ...messages],
          stream: true,
        }),
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`${provider} ${res.status}: ${errBody.slice(0, 120)}`);
    }

    // প্রথম আসল টোকেন পাওয়া পর্যন্ত অপেক্ষা—যাতে স্ট্রিম এরর হলেই আগে ফ্যালব্যাক হয়!
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstText = "";

    while (!firstText) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          buffer = "";
          for (const l of lines) {
            const t = l.trim();
            if (!t.startsWith("data:")) continue;
            const d = t.slice(5).trim();
            if (!d || d === "[DONE]") continue;
            try {
              firstText += extractToken(provider, JSON.parse(d));
            } catch (e) {
              if (!e.message.includes("JSON")) throw e;
            }
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try {
          firstText += extractToken(provider, JSON.parse(d));
        } catch (e) {
          if (!e.message.includes("JSON")) throw e;
        }
      }
    }

    clearTimeout(timeout);
    if (!firstText) throw new Error(`${candidate.label} খালি উত্তর পাঠিয়েছে`);

    return { firstText, reader, decoder, buffer, candidate };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const {
      messages = [],
      model = "auto",
      langMode = "auto",
      systemPrompt = "You are Star AI.",
      clientKeys = {},
    } = body;

    const cleanMessages = normalizeMessages(messages);
    if (!cleanMessages.length) {
      return Response.json({ error: "কোনো মেসেজ পাওয়া যায়নি।" }, { status: 400 });
    }

    const keys = {
      gemini: clientKeys.gemini || context.env.GEMINI_API_KEY || "",
      groq: clientKeys.groq || context.env.GROQ_API_KEY || "",
      openrouter: clientKeys.openrouter || context.env.OPENROUTER_API_KEY || "",
      cerebras: clientKeys.cerebras || context.env.CEREBRAS_API_KEY || "",
      mistral: clientKeys.mistral || context.env.MISTRAL_API_KEY || "",
    };

    const candidates = buildCandidateList(model, keys);
    if (!candidates.length) {
      return Response.json(
        {
          error:
            "কোনো API Key সেট করা নেই! Cloudflare Settings -> Variables & Secrets-এ অন্তত একটি Key (যেমন GEMINI_API_KEY বা GROQ_API_KEY) বসান অথবা ⚙️ Settings থেকে দিন।",
        },
        { status: 400 }
      );
    }

    const fullSystemPrompt = buildMultilingualPrompt(systemPrompt, langMode);
    let activeStream = null;
    const errors = [];

    for (let i = 0; i < candidates.length; i++) {
      try {
        activeStream = await openUpstream(
          candidates[i],
          keys[candidates[i].provider],
          cleanMessages,
          fullSystemPrompt
        );
        activeStream.isFallback = i > 0;
        break;
      } catch (err) {
        errors.push(`${candidates[i].label}: ${err.message}`);
      }
    }

    if (!activeStream) {
      return Response.json(
        { error: `সব ফ্রি API এই মুহূর্তে ব্যস্ত বা Key ভুল আছে (${errors[0] || "Unknown error"})` },
        { status: 502 }
      );
    }

    const { firstText, reader, decoder, buffer: initialBuffer, candidate, isFallback } = activeStream;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              meta: { provider: candidate.provider, label: candidate.label, fallback: isFallback },
            })}\n\n`
          )
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: firstText })}\n\n`));

        let buffer = initialBuffer;
        const pushLine = (rawLine) => {
          const t = rawLine.trim();
          if (!t.startsWith("data:")) return;
          const d = t.slice(5).trim();
          if (!d || d === "[DONE]") return;
          try {
            const token = extractToken(candidate.provider, JSON.parse(d));
            if (token) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: token })}\n\n`));
            }
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
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
