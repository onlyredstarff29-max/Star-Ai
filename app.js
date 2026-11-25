const DEFAULT_SYSTEM_PROMPT =
  "You are Star AI, a brilliant, helpful multilingual assistant fluent in Bengali (বাংলা), Banglish (Bengali in Roman letters), English, Hindi, Arabic, and every world language.";

const savedKeys = (() => {
  try {
    return JSON.parse(localStorage.getItem("star_ai_keys") || "{}");
  } catch {
    return {};
  }
})();

let state = {
  chats: JSON.parse(localStorage.getItem("star_ai_chats") || "[]"),
  currentChatId: localStorage.getItem("star_ai_current_id") || null,
  theme: localStorage.getItem("star_ai_theme") || "dark",
  model: localStorage.getItem("star_ai_model_v2") || "auto",
  langMode: localStorage.getItem("star_ai_lang") || "auto",
  micLang: localStorage.getItem("star_ai_mic_lang") || "bn-BD",
  systemPrompt: localStorage.getItem("star_ai_sys") || DEFAULT_SYSTEM_PROMPT,
  clientKeys: {
    gemini: savedKeys.gemini || "",
    groq: savedKeys.groq || "",
    openrouter: savedKeys.openrouter || "",
    cerebras: savedKeys.cerebras || "",
    mistral: savedKeys.mistral || "",
  },
  serverProviders: {},
};

let abortController = null;
let isGenerating = false;
let isComposing = false;

const el = (id) => document.getElementById(id);

if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}

function init() {
  applyTheme(state.theme);
  el("modelSelect").value = state.model;
  el("langSelect").value = state.langMode;
  el("micLangBtn").textContent = state.micLang === "bn-BD" ? "বাং" : "EN";

  if (!state.chats.length) createNewChat(false);
  else if (!state.chats.some((c) => c.id === state.currentChatId)) {
    state.currentChatId = state.chats[0].id;
  }

  renderChatList();
  renderMessages();
  checkServerProviders();
  bindEvents();
}

async function checkServerProviders() {
  const dot = el("serverStatusBadge");
  try {
    const res = await fetch("/api/chat");
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.serverProviders = data?.providers || {};

    const activeCount = Object.values(state.serverProviders).filter(Boolean).length;
    const localCount = Object.values(state.clientKeys).filter(Boolean).length;

    if (activeCount > 0 || localCount > 0) {
      dot.className = "status-dot online";
      dot.textContent = `● ${activeCount + localCount} API সচল`;
    } else {
      dot.className = "status-dot warn";
      dot.textContent = "● Key প্রয়োজন";
    }
  } catch {
    dot.className = "status-dot warn";
    dot.textContent = "● অফলাইন";
  }
  renderProviderPills();
}

function renderProviderPills() {
  const names = [
    ["gemini", "Gemini"],
    ["groq", "Groq"],
    ["openrouter", "OpenRouter"],
    ["cerebras", "Cerebras"],
    ["mistral", "Mistral"],
  ];
  el("providerStatusGrid").innerHTML = names
    .map(([k, label]) => {
      const on = Boolean(state.serverProviders[k] || state.clientKeys[k]);
      return `<span class="provider-pill ${on ? "active" : ""}">${on ? "✓" : "○"} ${label}</span>`;
    })
    .join("");
}

function saveState() {
  localStorage.setItem("star_ai_chats", JSON.stringify(state.chats));
  localStorage.setItem("star_ai_current_id", state.currentChatId || "");
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("star_ai_theme", theme);
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function createNewChat(focus = true) {
  const id = "chat_" + Date.now();
  state.chats.unshift({ id, title: "নতুন কথোপকথন", messages: [] });
  state.currentChatId = id;
  saveState();
  renderChatList();
  renderMessages();
  closeMobileSidebar();
  if (focus) el("promptInput").focus();
}

function deleteChat(id, event) {
  event.stopPropagation();
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.currentChatId === id) {
    state.currentChatId = state.chats[0]?.id || null;
  }
  if (!state.chats.length) createNewChat(false);
  else {
    saveState();
    renderChatList();
    renderMessages();
  }
}

function renderChatList() {
  const query = el("chatSearch").value.trim().toLowerCase();
  const filtered = state.chats.filter((c) => c.title.toLowerCase().includes(query));
  el("chatList").innerHTML = filtered.length
    ? filtered
        .map(
          (c) => `
      <div class="chat-item ${c.id === state.currentChatId ? "active" : ""}" data-id="${c.id}">
        <span class="chat-item-title">${escapeHtml(c.title)}</span>
        <button class="chat-del-btn" data-del="${c.id}" title="মুছুন">✕</button>
      </div>`
        )
        .join("")
    : `<div style="padding:14px;font-size:12.5px;color:var(--text-muted);text-align:center">কোনো চ্যাট পাওয়া যায়নি</div>`;
}

function formatMarkdown(text) {
  if (!window.marked) return `<p>${escapeHtml(text)}</p>`;
  return marked.parse(text || "");
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement.classList.contains("code-block-wrap")) return;
    const code = pre.querySelector("code");
    if (code && window.hljs) hljs.highlightElement(code);

    const langMatch = code?.className.match(/language-([\w-]+)/);
    const lang = langMatch ? langMatch[1] : "code";

    const wrap = document.createElement("div");
    wrap.className = "code-block-wrap";

    const header = document.createElement("div");
    header.className = "code-block-header";
    header.innerHTML = `<span>${escapeHtml(lang)}</span>`;

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    };

    header.appendChild(copyBtn);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(header);
    wrap.appendChild(pre);
  });
}

function renderMessages() {
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  const list = el("messagesList");
  const welcome = el("welcomeScreen");

  if (!chat || chat.messages.length === 0) {
    welcome.classList.remove("hidden");
    list.innerHTML = "";
    return;
  }

  welcome.classList.add("hidden");
  list.innerHTML = "";
  chat.messages.forEach((m, idx) =>
    appendMessageRow(m.role, m.content, idx === chat.messages.length - 1, idx, m.meta)
  );
  scrollToBottom();
}

function appendMessageRow(role, content, isLast = false, msgIndex = -1, meta = null) {
  el("welcomeScreen").classList.add("hidden");
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;

  if (role === "user") {
    if (msgIndex >= 0) {
      const editBtn = document.createElement("button");
      editBtn.className = "msg-edit-btn";
      editBtn.title = "এডিট করে আবার পাঠান";
      editBtn.textContent = "✎";
      editBtn.onclick = () => editUserMessage(msgIndex);
      row.appendChild(editBtn);
    }

    const bubble = document.createElement("div");
    bubble.className = "user-bubble notranslate";
    bubble.textContent = content;
    row.appendChild(bubble);
    el("messagesList").appendChild(row);
    scrollToBottom();
    return bubble;
  }

  const avatar = document.createElement("div");
  avatar.className = "bot-avatar";
  avatar.textContent = "✦";

  const contentWrap = document.createElement("div");
  contentWrap.className = "bot-content-wrap";

  const body = document.createElement("div");
  body.className = "markdown-body notranslate";
  if (content === null) {
    body.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  } else {
    body.innerHTML = formatMarkdown(content);
    enhanceCodeBlocks(body);
  }

  contentWrap.appendChild(body);
  if (content !== null) {
    contentWrap.appendChild(createActionButtons(content, isLast, meta));
  }

  row.appendChild(avatar);
  row.appendChild(contentWrap);
  el("messagesList").appendChild(row);
  scrollToBottom();
  return { body, contentWrap };
}

function createActionButtons(text, includeRegen, meta) {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "msg-act-btn";
  copyBtn.textContent = "📋 Copy";
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(text);
    copyBtn.textContent = "✓ Copied";
    setTimeout(() => (copyBtn.textContent = "📋 Copy"), 1500);
  };
  actions.appendChild(copyBtn);

  if (includeRegen) {
    const regenBtn = document.createElement("button");
    regenBtn.className = "msg-act-btn";
    regenBtn.textContent = "↻ Regenerate";
    regenBtn.onclick = regenerateLast;
    actions.appendChild(regenBtn);
  }

  if (meta?.label) {
    const badge = document.createElement("span");
    badge.className = `reply-meta-badge ${meta.fallback ? "fallback" : ""}`;
    badge.textContent = meta.fallback ? `⚡ Auto-Fallback • ${meta.label}` : `✦ ${meta.label}`;
    actions.appendChild(badge);
  }

  return actions;
}

function editUserMessage(idx) {
  if (isGenerating) return;
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat || !chat.messages[idx]) return;
  const text = chat.messages[idx].content;
  chat.messages = chat.messages.slice(0, idx);
  saveState();
  renderMessages();
  const input = el("promptInput");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

function scrollToBottom() {
  const c = el("chatContainer");
  c.scrollTop = c.scrollHeight;
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (isGenerating || !text) return;
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat) return;

  if (chat.messages.length === 0) {
    chat.title = text.slice(0, 36);
  }

  const msgIndex = chat.messages.length;
  chat.messages.push({ role: "user", content: text });
  saveState();
  renderChatList();
  appendMessageRow("user", text, false, msgIndex);

  await runCompletion(chat);
}

async function regenerateLast() {
  if (isGenerating) return;
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat || chat.messages.length < 1) return;
  if (chat.messages[chat.messages.length - 1].role === "assistant") {
    chat.messages.pop();
  }
  saveState();
  renderMessages();
  await runCompletion(chat);
}

async function runCompletion(chat) {
  isGenerating = true;
  el("sendBtn").classList.add("hidden");
  el("stopBtn").classList.remove("hidden");

  const botRefs = appendMessageRow("assistant", null);
  abortController = new AbortController();
  let fullReply = "";
  let replyMeta = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        messages: chat.messages.slice(-16).map((m) => ({ role: m.role, content: m.content })),
        model: state.model,
        langMode: state.langMode,
        systemPrompt: state.systemPrompt,
        clientKeys: state.clientKeys,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `সার্ভার এরর (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processLine = (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith("data:")) return;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") return;
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.meta) replyMeta = parsed.meta;
        if (parsed.text) {
          fullReply += parsed.text;
          botRefs.body.innerHTML = formatMarkdown(fullReply);
          scrollToBottom();
        }
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(processLine);
    }
    if (buffer.trim()) processLine(buffer);

    if (!fullReply) fullReply = "দুঃখিত, উত্তর পাওয়া যায়নি।";
    enhanceCodeBlocks(botRefs.body);
    chat.messages.push({ role: "assistant", content: fullReply, meta: replyMeta });
    saveState();
    botRefs.contentWrap.appendChild(createActionButtons(fullReply, true, replyMeta));
  } catch (err) {
    if (err.name === "AbortError") {
      if (fullReply) {
        enhanceCodeBlocks(botRefs.body);
        chat.messages.push({ role: "assistant", content: fullReply, meta: replyMeta });
        saveState();
        botRefs.contentWrap.appendChild(createActionButtons(fullReply, true, replyMeta));
      } else {
        botRefs.body.innerHTML = `<em style="color:var(--text-muted)">উত্তর থামানো হয়েছে।</em>`;
      }
    } else {
      botRefs.body.innerHTML = `<div style="color:#ef4444">⚠️ <strong>সমস্যা হয়েছে:</strong> ${escapeHtml(err.message)}</div>`;
    }
  } finally {
    isGenerating = false;
    abortController = null;
    el("stopBtn").classList.add("hidden");
    el("sendBtn").classList.remove("hidden");
  }
}

function closeMobileSidebar() {
  el("sidebar").classList.remove("open");
  el("sidebarOverlay").classList.remove("open");
}

function bindEvents() {
  el("menuBtn").onclick = () => {
    el("sidebar").classList.add("open");
    el("sidebarOverlay").classList.add("open");
  };
  el("closeSidebarBtn").onclick = closeMobileSidebar;
  el("sidebarOverlay").onclick = closeMobileSidebar;

  el("newChatBtn").onclick = () => createNewChat(true);
  el("chatSearch").oninput = renderChatList;

  el("chatList").onclick = (e) => {
    const delId = e.target.getAttribute("data-del");
    if (delId) return deleteChat(delId, e);
    const item = e.target.closest(".chat-item");
    if (item) {
      state.currentChatId = item.getAttribute("data-id");
      saveState();
      renderChatList();
      renderMessages();
      closeMobileSidebar();
    }
  };

  el("clearAllBtn").onclick = () => {
    if (!confirm("সব চ্যাট হিস্ট্রি মুছে ফেলতে চান?")) return;
    state.chats = [];
    createNewChat(true);
  };

  el("modelSelect").onchange = (e) => {
    state.model = e.target.value;
    localStorage.setItem("star_ai_model_v2", state.model);
  };

  el("langSelect").onchange = (e) => {
    state.langMode = e.target.value;
    localStorage.setItem("star_ai_lang", state.langMode);
  };

  el("themeToggleBtn").onclick = () =>
    applyTheme(state.theme === "dark" ? "light" : "dark");

  el("exportChatBtn").onclick = () => {
    const chat = state.chats.find((c) => c.id === state.currentChatId);
    if (!chat || !chat.messages.length) return alert("ডাউনলোড করার মতো কোনো চ্যাট নেই!");
    const md = chat.messages
      .map((m) => `### ${m.role === "user" ? "You" : "Star AI"}\n${m.content}\n`)
      .join("\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${chat.title.replace(/\s+/g, "_")}.md`;
    a.click();
  };

  const input = el("promptInput");
  input.addEventListener("compositionstart", () => (isComposing = true));
  input.addEventListener("compositionend", () => (isComposing = false));
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 170) + "px";
  };
  input.onkeydown = (e) => {
    if (e.isComposing || isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el("promptForm").dispatchEvent(new Event("submit"));
    }
  };

  el("promptForm").onsubmit = (e) => {
    e.preventDefault();
    const val = input.value;
    if (!val.trim() || isGenerating) return;
    input.value = "";
    input.style.height = "auto";
    sendMessage(val);
  };

  el("stopBtn").onclick = () => abortController?.abort();

  document.querySelectorAll(".suggestion-card").forEach((btn) => {
    btn.onclick = () => sendMessage(btn.getAttribute("data-prompt"));
  });

  // Voice Input with Bangla / English Switch
  el("micLangBtn").onclick = () => {
    state.micLang = state.micLang === "bn-BD" ? "en-US" : "bn-BD";
    localStorage.setItem("star_ai_mic_lang", state.micLang);
    el("micLangBtn").textContent = state.micLang === "bn-BD" ? "বাং" : "EN";
  };

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec) {
    let rec = null;
    el("micBtn").onclick = () => {
      if (el("micBtn").classList.contains("listening") && rec) {
        rec.stop();
        return;
      }
      rec = new SpeechRec();
      rec.lang = state.micLang;
      rec.interimResults = false;
      el("micBtn").classList.add("listening");
      rec.start();

      rec.onresult = (e) => {
        const spoken = e.results?.[0]?.[0]?.transcript || "";
        if (spoken) {
          input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + spoken;
          input.dispatchEvent(new Event("input"));
        }
      };
      rec.onend = () => el("micBtn").classList.remove("listening");
      rec.onerror = () => el("micBtn").classList.remove("listening");
    };
  } else {
    el("micBtn").style.display = "none";
    el("micLangBtn").style.display = "none";
  }

  // Settings Modal
  el("settingsBtn").onclick = () => {
    renderProviderPills();
    el("systemPromptInput").value = state.systemPrompt;
    el("keyGemini").value = state.clientKeys.gemini;
    el("keyGroq").value = state.clientKeys.groq;
    el("keyOpenrouter").value = state.clientKeys.openrouter;
    el("keyCerebras").value = state.clientKeys.cerebras;
    el("keyMistral").value = state.clientKeys.mistral;
    el("settingsModal").classList.remove("hidden");
  };
  el("closeSettingsBtn").onclick = () => el("settingsModal").classList.add("hidden");
  el("saveSettingsBtn").onclick = () => {
    state.systemPrompt = el("systemPromptInput").value.trim() || DEFAULT_SYSTEM_PROMPT;
    state.clientKeys = {
      gemini: el("keyGemini").value.trim(),
      groq: el("keyGroq").value.trim(),
      openrouter: el("keyOpenrouter").value.trim(),
      cerebras: el("keyCerebras").value.trim(),
      mistral: el("keyMistral").value.trim(),
    };
    localStorage.setItem("star_ai_sys", state.systemPrompt);
    localStorage.setItem("star_ai_keys", JSON.stringify(state.clientKeys));
    el("settingsModal").classList.add("hidden");
    checkServerProviders();
  };
}

init();
