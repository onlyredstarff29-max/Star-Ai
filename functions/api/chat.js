export async function onRequestGet(context) {
  return Response.json({
    providers: {
      groq: Boolean(context.env.GROQ_API_KEY),
      gemini: Boolean(context.env.GEMINI_API_KEY),
    },
  });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const {
      messages = [],
      model = "openai/gpt-oss-120b",
      systemPrompt = "You are Star AI, a helpful assistant.",
      clientProvider = "auto",
      clientKey,
    } = body;

    const isGeminiModel = model.startsWith("gemini-");
    let useGemini = isGeminiModel;

    if (clientKey && clientProvider === "gemini") useGemini = true;
    if (clientKey && clientProvider === "groq") useGemini = false;

    const apiKey = useGemini
      ? clientKey || context.env.GEMINI_API_KEY
      : clientKey || context.env.GROQ_API_KEY;

    if (!apiKey) {
      return Response.json(
        {
          error:
            "API Key পাওয়া যায়নি! Cloudflare Settings -> Variables & Secrets-এ GROQ_API_KEY বা GEMINI_API_KEY যোগ করুন, অথবা ওপরে ⚙️ Settings থেকে আপনার ফ্রি Key দিন।",
        },
        { status: 400 }
      );
    }

    let upstreamRes;

    if (useGemini) {
      const geminiModel = isGeminiModel ? model : "gemini-3.8-flash";
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      upstreamRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature: 0.7 },
          }),
        }
      );
    } else {
      const groqModel = isGeminiModel ? "openai/gpt-oss-120b" : model;
      upstreamRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          temperature: 0.7,
          stream: true,
        }),
      });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return Response.json(
        { error: `AI API Error (${upstreamRes.status}): ${errText.slice(0, 200)}` },
        { status: upstreamRes.status }
      );
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        const handleLine = (rawLine) => {
          const trimmed = rawLine.trim();
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") return;
          try {
            const json = JSON.parse(dataStr);
            let text = "";
            if (useGemini) {
              const parts = json.candidates?.[0]?.content?.parts || [];
              text = parts
                .filter((p) => !p.thought)
                .map((p) => p.text || "")
                .join("");
            } else {
              text = json.choices?.[0]?.delta?.content || "";
            }
            if (text) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
              );
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
            lines.forEach(handleLine);
          }
          if (buffer.trim()) handleLine(buffer);
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
