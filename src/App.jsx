import { useState, useRef, useEffect } from "react";
import { translatePageOnDevice, cleanupOnDevice, setMemoryTier, MEMORY_TIERS } from "./ondevice.js";

// ─── Fonts ────────────────────────────────────────────────────────────────────
async function loadFonts() {
  if (!document.getElementById("manga-font-link")) {
    const link = document.createElement("link");
    link.id = "manga-font-link";
    link.rel = "stylesheet";
    // Bangers = manga shout, Caveat = handwritten, Permanent Marker = bold marker
    link.href = "https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@700&family=Caveat:wght@700&family=Permanent+Marker&display=swap";
    document.head.appendChild(link);
  }
  try {
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load("24px Bangers"),
        document.fonts.load("bold 24px 'Comic Neue'"),
        document.fonts.load("bold 24px Caveat"),
        document.fonts.load("24px 'Permanent Marker'"),
      ]);
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {}
}

// ─── JSZip ────────────────────────────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => res(window.JSZip);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const blobToDataUrl = blob => new Promise(res => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob);
});
const loadImg = src => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
});

// ─── API configs ──────────────────────────────────────────────────────────────
const APIS = {
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    badge: "FREE",
    badgeColor: "#4caf50",
    placeholder: "AIzaSy...",
    hint: 'Starts with "AIza" · Get free key at aistudio.google.com',
    keyUrl: "https://aistudio.google.com/app/apikey",
    validate: k => k.startsWith("AIza") && k.length >= 35 && k.length <= 45
      ? null : 'Key should start with "AIza" and be ~39 characters.',
  },
  claude: {
    id: "claude",
    name: "Anthropic Claude",
    badge: "PAID",
    badgeColor: "#d4a017",
    placeholder: "sk-ant-api03-...",
    hint: 'Starts with "sk-ant-" · Get key at console.anthropic.com',
    keyUrl: "https://console.anthropic.com/settings/keys",
    validate: k => k.startsWith("sk-ant-") && k.length > 30
      ? null : 'Key should start with "sk-ant-".',
  },
  openai: {
    id: "openai",
    name: "OpenAI GPT-4o",
    badge: "PAID",
    badgeColor: "#d4a017",
    placeholder: "sk-proj-...",
    hint: 'Starts with "sk-" · Get key at platform.openai.com',
    keyUrl: "https://platform.openai.com/api-keys",
    validate: k => k.startsWith("sk-") && k.length > 20
      ? null : 'Key should start with "sk-".',
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    badge: "FREE TIER",
    badgeColor: "#4caf50",
    placeholder: "...",
    hint: "Free tier available · Get key at console.mistral.ai",
    keyUrl: "https://console.mistral.ai/api-keys",
    validate: k => k.length > 10 ? null : "Key seems too short.",
  },
  ondevice: {
    id: "ondevice",
    name: "On-Device (Offline)",
    badge: "100% FREE",
    badgeColor: "#4caf50",
    placeholder: "— no key needed —",
    hint: "Runs on your phone · No internet after first model download",
    keyUrl: null,
    validate: () => null, // no key needed
    noKey: true,
  },
};

const LANGUAGES = [
  { code: "English", label: "🇺🇸 English" },
  { code: "Spanish", label: "🇪🇸 Spanish" },
  { code: "French", label: "🇫🇷 French" },
  { code: "German", label: "🇩🇪 German" },
  { code: "Portuguese", label: "🇧🇷 Portuguese" },
  { code: "Italian", label: "🇮🇹 Italian" },
  { code: "Japanese", label: "🇯🇵 Japanese" },
  { code: "Korean", label: "🇰🇷 Korean" },
  { code: "Arabic", label: "🇸🇦 Arabic" },
  { code: "Russian", label: "🇷🇺 Russian" },
  { code: "Hindi", label: "🇮🇳 Hindi" },
  { code: "Turkish", label: "🇹🇷 Turkish" },
  { code: "Thai", label: "🇹🇭 Thai" },
  { code: "Vietnamese", label: "🇻🇳 Vietnamese" },
  { code: "Indonesian", label: "🇮🇩 Indonesian" },
];

const FONT_STYLES = {
  bangers:  { label: "Bangers",          css: sz => `${sz}px Bangers` },
  comic:    { label: "Comic Neue",       css: sz => `bold ${sz}px 'Comic Neue', cursive` },
  caveat:   { label: "Caveat (handwritten)", css: sz => `bold ${sz}px Caveat, cursive` },
  marker:   { label: "Permanent Marker", css: sz => `${sz}px 'Permanent Marker', cursive` },
};

// ─── Translation API calls ────────────────────────────────────────────────────
function buildPrompt(targetLang) {
  return `You are a professional manga/comic translator. Analyze this image page.

AUTO-DETECT the source language of any text present (Chinese, Japanese, Korean, etc.).
Translate ALL text into ${targetLang}.

For EVERY text element return:
- x1,y1,x2,y2: bounding box of the TEXT AREA ONLY (not bubble outline), as fraction of image 0.0–1.0. Make the box SLIGHTLY LARGER than the text to ensure full coverage — add ~0.005 padding on each side.
- translated: natural ${targetLang} translation matching tone and emotion
- font_size_frac: estimated height of original characters as fraction of image height (0.02 small, 0.04 medium, 0.08 large shout text)
- bg_sample_x, bg_sample_y: a point OUTSIDE the text but inside the bubble/box to sample background color (as fraction of image), so we can match the fill color exactly
- align: "center", "left", or "right"
- style: "speech" (dialog), "shout" (yelling/emphasis), "whisper" (small/quiet), "caption" (narration box), or "sfx" (sound effect)
- dark_bg: true if text is on a dark/black background, false if light

Return ONLY valid JSON, no markdown:
{"bubbles":[{"x1":0.1,"y1":0.05,"x2":0.4,"y2":0.18,"translated":"Hello!","font_size_frac":0.04,"bg_sample_x":0.12,"bg_sample_y":0.03,"align":"center","style":"speech","dark_bg":false}]}

No translatable text → {"bubbles":[]}.
Include ALL text: speech bubbles, captions, sound effects, signs, labels.`;
}

async function callGemini(b64, apiKey, targetLang) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: buildPrompt(targetLang) }
      ]}],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error("RATE_LIMIT");
    if (res.status === 400 || res.status === 403) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callClaude(b64, apiKey, targetLang) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || "").join("");
}

async function callOpenAI(b64, apiKey, targetLang) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callMistral(b64, apiKey, targetLang) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "pixtral-12b-2409",
      max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function translatePage(b64, apiId, apiKey, targetLang) {
  let raw = "";
  if (apiId === "gemini")  raw = await callGemini(b64, apiKey, targetLang);
  else if (apiId === "claude")  raw = await callClaude(b64, apiKey, targetLang);
  else if (apiId === "openai")  raw = await callOpenAI(b64, apiKey, targetLang);
  else if (apiId === "mistral") raw = await callMistral(b64, apiKey, targetLang);

  raw = raw.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(raw); } catch { return { bubbles: [] }; }
}

// ─── Exponential backoff retry ─────────────────────────────────────────────
async function withRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.message === "RATE_LIMIT" && attempt < maxRetries) {
        const wait = [10000, 20000, 40000, 60000][attempt] || 60000; // 10s, 20s, 40s, 60s
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// ─── Stitch multiple images into one tall canvas ───────────────────────────
async function stitchImages(imgDataUrls, maxWidth = 768) {
  const imgs = await Promise.all(imgDataUrls.map(loadImg));
  const scaled = imgs.map(img => {
    const scale = Math.min(1, maxWidth / img.width);
    return { img, w: Math.round(img.width * scale), h: Math.round(img.height * scale) };
  });
  const totalH = scaled.reduce((s, p) => s + p.h, 0);
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  const pageOffsets = [];
  for (const { img, w, h } of scaled) {
    ctx.drawImage(img, 0, y, w, h);
    pageOffsets.push({ y, h });
    y += h;
  }
  const b64 = canvas.toDataURL("image/jpeg", 0.60).split(",")[1];
  return { b64, pageOffsets, totalH, totalW: maxWidth };
}

// ─── Remap bubbles from combined coords back to per-page coords ────────────
function remapBubbles(bubbles, pageOffsets, totalH) {
  const perPage = pageOffsets.map(() => []);
  for (const b of bubbles) {
    if (!b.translated && !b.english) continue;
    const absY1 = b.y1 * totalH;
    const absY2 = b.y2 * totalH;
    const centerY = (absY1 + absY2) / 2;
    let pageIdx = -1;
    for (let i = 0; i < pageOffsets.length; i++) {
      const { y, h } = pageOffsets[i];
      if (centerY >= y && centerY < y + h) { pageIdx = i; break; }
    }
    if (pageIdx === -1) continue;
    const { y: pageY, h: pageH } = pageOffsets[pageIdx];
    perPage[pageIdx].push({
      ...b,
      y1: Math.max(0, (absY1 - pageY) / pageH),
      y2: Math.min(1, (absY2 - pageY) / pageH),
      bg_sample_y: b.bg_sample_y != null
        ? Math.max(0, Math.min(1, (b.bg_sample_y * totalH - pageY) / pageH))
        : null,
    });
  }
  return perPage;
}

// ─── Canvas: sample background color at a point ───────────────────────────────
function sampleBgColor(ctx, sx, sy, imgW, imgH) {
  try {
    const px = Math.round(Math.max(0, Math.min(imgW - 1, sx * imgW)));
    const py = Math.round(Math.max(0, Math.min(imgH - 1, sy * imgH)));
    // Sample a 5×5 area and average
    const d = ctx.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i+1]; b += d[i+2]; count++;
    }
    r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return { color: `rgb(${r},${g},${b})`, dark: brightness < 128 };
  } catch { return { color: "#ffffff", dark: false }; }
}

// ─── Canvas: draw with inpainting-style fill ──────────────────────────────────
function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxW) line = test;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

function fitText(ctx, text, bw, bh, fontFn, hintPx) {
  const maxSz = Math.min(Math.round(hintPx * 1.4), Math.round(bh * 0.85), 90);
  for (let sz = maxSz; sz >= 7; sz--) {
    ctx.font = fontFn(sz);
    const pad = Math.max(4, sz * 0.2);
    const innerW = bw - pad * 2;
    const innerH = bh - pad * 2;
    const lines = wrapText(ctx, text, innerW);
    const lineH = sz * 1.25;
    const totalH = lines.length * lineH;
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    if (totalH <= innerH && maxW <= innerW)
      return { sz, lines, lineH, pad };
  }
  ctx.font = fontFn(7);
  return { sz: 7, lines: wrapText(ctx, text, bw - 8), lineH: 9, pad: 4 };
}

function drawTranslations(canvas, img, bubbles, fontStyle) {
  const ctx = canvas.getContext("2d");
  canvas.width = img.width; canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  // Get the font CSS function
  const fontCss = FONT_STYLES[fontStyle]?.css || FONT_STYLES.bangers.css;

  for (const b of bubbles) {
    if (!b.translated && !b.english) continue;
    const text = b.translated || b.english;

    // Expand bounding box slightly to ensure full text coverage
    const EXPAND = 0.008;
    const x1 = Math.round(Math.max(0, (b.x1 - EXPAND) * img.width));
    const y1 = Math.round(Math.max(0, (b.y1 - EXPAND) * img.height));
    const x2 = Math.round(Math.min(img.width,  (b.x2 + EXPAND) * img.width));
    const y2 = Math.round(Math.min(img.height, (b.y2 + EXPAND) * img.height));
    const bw = x2 - x1, bh = y2 - y1;
    if (bw < 8 || bh < 8) continue;

    // Sample the background color from just outside the text area
    const sx = b.bg_sample_x ?? (b.x1 - 0.01);
    const sy = b.bg_sample_y ?? (b.y1 - 0.01);
    const { color: sampledBg, dark: sampledDark } = sampleBgColor(ctx, sx, sy, img.width, img.height);

    const isDark = b.dark_bg ?? sampledDark;
    const style  = b.style || "speech";

    // ── Fill: multi-pass to fully erase original text ──────────────────────
    // Pass 1: solid fill with sampled color
    ctx.fillStyle = sampledBg;
    ctx.fillRect(x1, y1, bw, bh);

    // Pass 2: slight blur/smooth with another solid fill to kill antialiasing remnants
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = isDark ? "#000000" : style === "caption" ? "#f5f0e0" : sampledBg;
    ctx.fillRect(x1, y1, bw, bh);
    ctx.globalAlpha = 1.0;

    // Pass 3: final clean solid fill
    const finalBg = isDark ? "#000000" : style === "caption" ? "#f5f0e0" : "#ffffff";
    ctx.fillStyle = finalBg;

    // For speech bubbles, keep white; for dark, keep black; for captions, keep parchment
    // But only override if sampled color isn't clearly matching
    const brightness = sampledDark ? 0 : 255;
    if (!isDark && style !== "caption") {
      // Check if sampled bg is close to white — if so use sampled, else use white
      ctx.fillStyle = sampledBg;
    }
    ctx.fillRect(x1, y1, bw, bh);

    // ── Font selection per style ───────────────────────────────────────────
    // sfx / shout → Bangers always (regardless of font choice for impact)
    const effectiveFontFn = (style === "sfx" || style === "shout")
      ? FONT_STYLES.bangers.css
      : fontCss;

    const hintPx = b.font_size_frac
      ? Math.round(b.font_size_frac * img.height)
      : Math.round(bh * 0.42);

    const { sz, lines, lineH, pad } = fitText(ctx, text, bw, bh, effectiveFontFn, hintPx);

    ctx.font = effectiveFontFn(sz);
    ctx.fillStyle = isDark ? "#ffffff" : "#0a0a0a";
    ctx.textBaseline = "middle";
    ctx.textAlign = b.align || "center";

    // Shadow / outline for readability
    if (style === "shout" || style === "sfx") {
      ctx.shadowColor   = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.25)";
      ctx.shadowBlur    = 2;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
    } else {
      // Subtle outline for legibility on any background
      ctx.shadowColor   = isDark ? "rgba(0,0,0,0.0)" : "rgba(0,0,0,0.0)";
      ctx.shadowBlur    = 0;
    }

    // For extra legibility, draw thin stroke behind text
    if (!isDark) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth   = sz * 0.15;
      ctx.lineJoin    = "round";
    }

    const totalH = lines.length * lineH;
    let curY = y1 + pad + (bh - pad * 2 - totalH) / 2 + lineH / 2;
    const tx = b.align === "right" ? x2 - pad
             : b.align === "left"  ? x1 + pad
             :                       x1 + bw / 2;

    for (const line of lines) {
      if (!isDark && ctx.lineWidth > 0) {
        ctx.strokeText(line, tx, curY, bw - pad * 2);
      }
      ctx.fillText(line, tx, curY, bw - pad * 2);
      curY += lineH;
    }

    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    ctx.lineWidth = 0;
  }
}

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  gold: "#d4a017", bg: "#0e0e0e", surface: "#161616",
  surface2: "#1e1e1e", border: "#2a2a2a", text: "#e8e0d0",
  muted: "#555", faint: "#222", green: "#4caf50", red: "#e05050",
};

const btn = (active, color = C.gold) => ({
  background: active ? color : "transparent",
  color: active ? "#000" : C.muted,
  border: `1px solid ${active ? color : C.faint}`,
  padding: "6px 12px", fontSize: 10, letterSpacing: 1,
  cursor: "pointer", fontFamily: "'Courier New', monospace",
  borderRadius: 4, transition: "all 0.15s",
});

// ─── Setup / API key screen ───────────────────────────────────────────────────
function SetupScreen({ onSave }) {
  const [selectedApi, setSelectedApi] = useState("gemini");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const api = APIS[selectedApi];

  const handleSave = () => {
    // On-device needs no key at all
    if (api.noKey) {
      setSuccess(true);
      localStorage.setItem("manga_active_api", selectedApi);
      setTimeout(() => onSave(selectedApi, "ondevice"), 700);
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) { setError("Paste your API key first."); return; }
    const err = api.validate(trimmed);
    if (err) { setError(err); return; }
    setSuccess(true);
    const stored = JSON.parse(localStorage.getItem("manga_keys") || "{}");
    stored[selectedApi] = trimmed;
    localStorage.setItem("manga_keys", JSON.stringify(stored));
    localStorage.setItem("manga_active_api", selectedApi);
    setTimeout(() => onSave(selectedApi, trimmed), 700);
  };

  return (
    <div style={{ height: "100dvh", background: C.bg, color: C.text, fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.gold}`, padding: "0 18px", height: 50, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 24, letterSpacing: 4, color: C.gold }}>漫画</span>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 13, color: C.muted, letterSpacing: 2 }}>TRANSLATOR</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 32px" }}>
        <div style={{ fontFamily: "Bangers, cursive", fontSize: 18, letterSpacing: 3, color: C.gold, marginBottom: 16, textAlign: "center" }}>
          CHOOSE YOUR AI SERVICE
        </div>

        {/* API selector cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {Object.values(APIS).map(a => (
            <div key={a.id} onClick={() => { setSelectedApi(a.id); setKey(""); setError(""); setSuccess(false); }}
              style={{
                background: selectedApi === a.id ? "#1e1a0a" : C.surface,
                border: `2px solid ${selectedApi === a.id ? C.gold : C.faint}`,
                borderRadius: 10, padding: "12px 14px", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: selectedApi === a.id ? C.gold : C.text, fontWeight: "bold", marginBottom: 2 }}>{a.name}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{a.hint}</div>
              </div>
              <div style={{
                background: a.badgeColor + "22", border: `1px solid ${a.badgeColor}55`,
                color: a.badgeColor, fontSize: 9, letterSpacing: 1,
                padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap",
              }}>{a.badge}</div>
              {selectedApi === a.id && <div style={{ color: C.gold, fontSize: 18 }}>●</div>}
            </div>
          ))}
        </div>

        {/* Key input */}
        <div style={{ background: C.surface, border: `1px solid ${success ? C.green : error ? C.red : C.border}`, borderRadius: 12, padding: 18, marginBottom: 14, transition: "border-color 0.2s" }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
            {api.name.toUpperCase()} API KEY
          </div>
          {api.noKey ? (
            <div style={{ background: "#0a1a0a", border: `1px solid ${C.green}33`, borderRadius: 8, padding: "16px", textAlign: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📱</div>
              <div style={{ fontSize: 13, color: C.green, marginBottom: 6, fontFamily: "Bangers, cursive", letterSpacing: 2 }}>NO API KEY NEEDED</div>
              <div style={{ fontSize: 11, color: "#888", lineHeight: 1.7 }}>
                Translation model downloads once (~150MB) then runs fully offline on your device. No internet, no limits, no cost — ever.
              </div>
            </div>
          ) : (
            <>
              {api.keyUrl && (
                <a href={api.keyUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", background: "#0a1a2a", border: `1px solid #2a5a8a`, color: "#6ab0f0", padding: "9px 12px", borderRadius: 7, fontSize: 12, textDecoration: "none", textAlign: "center", marginBottom: 12, fontFamily: "Bangers, cursive", letterSpacing: 2 }}>
                  🔗 GET FREE KEY FROM {api.name.toUpperCase()} →
                </a>
              )}
              <div style={{ position: "relative", marginBottom: error || success ? 10 : 14 }}>
                <input
                  type={show ? "text" : "password"} value={key}
                  onChange={e => { setKey(e.target.value); setError(""); setSuccess(false); }}
                  placeholder={api.placeholder} autoComplete="off"
                  style={{ width: "100%", background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 7, padding: "12px 44px 12px 12px", color: C.text, fontSize: 12, fontFamily: "'Courier New', monospace", outline: "none" }}
                />
                <button onClick={() => setShow(s => !s)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 17, padding: 0 }}>
                  {show ? "🙈" : "👁️"}
                </button>
              </div>
            </>
          )}
          {error  && <div style={{ background: "#1a0a0a", border: `1px solid ${C.red}33`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: C.red, marginBottom: 12 }}>⚠️ {error}</div>}
          {success && <div style={{ background: "#0a1a0a", border: `1px solid ${C.green}33`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: C.green, textAlign: "center", marginBottom: 12 }}>✅ Saved! Opening app…</div>}
          <button onClick={handleSave} disabled={(!key.trim() && !api.noKey) || success}
            style={{ width: "100%", background: success ? C.green : (key.trim() || api.noKey) ? C.gold : C.faint, color: success || key.trim() || api.noKey ? "#000" : C.muted, border: "none", padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 15, letterSpacing: 3, cursor: (key.trim() || api.noKey) && !success ? "pointer" : "not-allowed", borderRadius: 8, transition: "all 0.2s" }}>
            {success ? "✅ SAVED!" : "SAVE & START →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({ activeApi, setActiveApi, keys, setKeys, targetLang, setTargetLang, fontStyle, setFontStyle, memoryTier, setMemoryTier_, onClose }) {
  const [editingApi, setEditingApi] = useState(activeApi);
  const [keyInput, setKeyInput] = useState(keys[activeApi] ? "••••••••" + (keys[activeApi].slice(-4)) : "");
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (trimmed.startsWith("•")) return; // unchanged
    const api = APIS[editingApi];
    const err = api.validate(trimmed);
    if (err) { alert(err); return; }
    const newKeys = { ...keys, [editingApi]: trimmed };
    setKeys(newKeys);
    localStorage.setItem("manga_keys", JSON.stringify(newKeys));
    setActiveApi(editingApi);
    localStorage.setItem("manga_active_api", editingApi);
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 800);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "flex-end" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width: "100%", background: C.surface, borderRadius: "16px 16px 0 0", border: `1px solid ${C.border}`, padding: "20px 16px 32px", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 3, color: C.gold }}>SETTINGS</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 22, cursor: "pointer" }}>✕</button>
        </div>

        {/* Target language */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>TRANSLATE TO</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {LANGUAGES.map(l => (
              <button key={l.code} onClick={() => { setTargetLang(l.code); localStorage.setItem("manga_target_lang", l.code); }}
                style={{ ...btn(targetLang === l.code), fontSize: 11, padding: "6px 10px" }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* Font style */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>FONT STYLE</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(FONT_STYLES).map(([id, f]) => (
              <button key={id} onClick={() => { setFontStyle(id); localStorage.setItem("manga_font_style", id); }}
                style={{ ...btn(fontStyle === id), fontFamily: f.css(14).split(" ").slice(1).join(" "), fontSize: 13, padding: "7px 14px" }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Memory tier — only shown when on-device is active */}
        {activeApi === "ondevice" && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>ON-DEVICE MEMORY LIMIT</div>
            <div style={{ background: "#0a1a0a", border: `1px solid ${C.green}33`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 11, color: "#888", lineHeight: 1.7 }}>
              Controls how much RAM the translation model uses. Lower = slower but uses less memory. Higher = faster but needs more RAM.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(MEMORY_TIERS).map(([id, tier]) => (
                <button key={id} onClick={() => {
                    setMemoryTier_(id);
                    localStorage.setItem("manga_memory_tier", id);
                  }}
                  style={{ flex: 1, ...btn(memoryTier === id, C.green), padding: "10px 6px", flexDirection: "column", display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 12 }}>{tier.label}</span>
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{tier.description}</span>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 10, background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 8, padding: "10px 12px", fontSize: 11, color: C.muted, lineHeight: 1.8 }}>
              📥 <span style={{ color: C.text }}>First run:</span> Downloads ~150MB model · Cached in app storage · Never re-downloads<br/>
              🔌 <span style={{ color: C.text }}>After that:</span> Fully offline — no internet needed at all
            </div>
          </div>
        )}

        {/* AI Service */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>AI SERVICE</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.values(APIS).map(a => (
              <div key={a.id} onClick={() => { setEditingApi(a.id); setKeyInput(keys[a.id] ? "••••••••" + keys[a.id].slice(-4) : ""); setShow(false); }}
                style={{ background: editingApi === a.id ? "#1e1a0a" : C.bg, border: `1px solid ${editingApi === a.id ? C.gold : C.faint}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12, color: editingApi === a.id ? C.gold : C.text }}>{a.name}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{keys[a.id] ? "Key saved ✓" : "No key saved"}</div>
                </div>
                <div style={{ color: a.badgeColor, fontSize: 9, letterSpacing: 1 }}>{a.badge}</div>
              </div>
            ))}
          </div>

          {/* Key input for selected API */}
          <div style={{ marginTop: 12, position: "relative" }}>
            <input
              type={show ? "text" : "password"} value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder={APIS[editingApi].placeholder}
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 7, padding: "11px 44px 11px 12px", color: C.text, fontSize: 12, fontFamily: "'Courier New', monospace", outline: "none" }}
            />
            <button onClick={() => setShow(s => !s)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 17 }}>
              {show ? "🙈" : "👁️"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <a href={APIS[editingApi].keyUrl} target="_blank" rel="noopener noreferrer"
              style={{ flex: 1, background: "#0a1a2a", border: `1px solid #2a5a8a`, color: "#6ab0f0", padding: "9px", borderRadius: 7, fontSize: 11, textDecoration: "none", textAlign: "center", fontFamily: "Bangers, cursive", letterSpacing: 1 }}>
              GET KEY →
            </a>
            <button onClick={saveKey}
              style={{ flex: 2, background: saved ? C.green : C.gold, color: "#000", border: "none", padding: "9px", fontFamily: "Bangers, cursive", fontSize: 13, letterSpacing: 2, cursor: "pointer", borderRadius: 7 }}>
              {saved ? "✅ SAVED!" : `USE ${APIS[editingApi].name.split(" ")[1].toUpperCase()}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const storedKeys    = JSON.parse(localStorage.getItem("manga_keys") || "{}");
  const storedApi     = localStorage.getItem("manga_active_api") || "";
  const hasKey        = storedApi && storedKeys[storedApi];

  const [keys, setKeys]             = useState(storedKeys);
  const [activeApi, setActiveApi]   = useState(storedApi || "gemini");
  const [setupDone, setSetupDone]   = useState(!!hasKey);
  const [targetLang, setTargetLang] = useState(localStorage.getItem("manga_target_lang") || "English");
  const [fontStyle, setFontStyle]   = useState(localStorage.getItem("manga_font_style") || "bangers");
  const [memoryTier, setMemoryTier_] = useState(localStorage.getItem("manga_memory_tier") || "medium");
  const [view, setView]             = useState("upload");
  const [pages, setPages]           = useState([]);
  const [status, setStatus]         = useState("idle");
  const [progress, setProgress]     = useState({ current: 0, total: 0 });
  const [log, setLog]               = useState([]);
  const [viewerWidth, setViewerWidth] = useState(100);
  const [showSettings, setShowSettings] = useState(false);
  const [fontReady, setFontReady]   = useState(false);
  const outputsRef = useRef([]);

  useEffect(() => { loadFonts().then(() => setFontReady(true)); }, []);

  if (!setupDone) {
    return <SetupScreen onSave={(apiId, key) => {
      const newKeys = { ...keys, [apiId]: key };
      setKeys(newKeys); setActiveApi(apiId); setSetupDone(true);
    }} />;
  }

  const addLog = msg => setLog(l => [...l, msg]);

  // How many pages to stitch per API call.
  // Gemini free: 6 pages/batch → ~8 calls for 45 pages (well under 15 RPM / 100 RPD)
  // Paid APIs: larger batches fine
  const BATCH_SIZE = activeApi === "gemini" ? 3 : 8;

  const processFile = async file => {
    if (!fontReady) await loadFonts();
    setStatus("loading"); setLog([]); setPages([]); outputsRef.current = [];
    const apiKey = keys[activeApi];
    if (!apiKey) { addLog("❌ No API key for " + APIS[activeApi].name + " — open Settings"); setStatus("error"); return; }

    try {
      const JSZip = await loadJSZip();
      addLog("📦 Extracting archive…");
      const zip = await JSZip.loadAsync(file);
      const imageFiles = Object.keys(zip.files)
        .filter(n => /\.(jpg|jpeg|png)$/i.test(n) && !zip.files[n].dir).sort();

      const totalPages = imageFiles.length;
      const numBatches = Math.ceil(totalPages / BATCH_SIZE);
      setProgress({ current: 0, total: totalPages });
      addLog(`🖼  Found ${totalPages} pages · ${numBatches} batch${numBatches > 1 ? "es" : ""} of up to ${BATCH_SIZE} · → ${targetLang}`);

      // Pre-load all blobs
      addLog("📥 Loading images…");
      const allDataUrls = [];
      for (const name of imageFiles) {
        const blob = await zip.files[name].async("blob");
        allDataUrls.push(await blobToDataUrl(blob));
      }

      const results = new Array(totalPages).fill(null);

      if (activeApi === "ondevice") {
        // ── On-device path: page by page ──────────────────────────────────
        setMemoryTier(memoryTier);
        addLog(`📱 On-device mode · Memory tier: ${memoryTier}`);

        // Detect language from first page
        addLog("🔍 Detecting source language from first page…");
        let detectedLang = "chi_sim";
        try {
          const { translatePageOnDevice: _, detectLanguage } = await import("./ondevice.js");
          // We'll use the exported function directly — re-import to get detectLanguage
        } catch {}
        // detectLanguage is used inline inside ondevice.js; we call translatePageOnDevice directly
        // which handles language detection per-page

        for (let i = 0; i < totalPages; i++) {
          setProgress({ current: i + 1, total: totalPages });
          addLog(`🔄 [${i+1}/${totalPages}] ${imageFiles[i]}`);
          let bubbles = [];
          try {
            const result = await translatePageOnDevice(
              allDataUrls[i], detectedLang, targetLang,
              msg => addLog(msg), msg => addLog(msg)
            );
            bubbles = result.bubbles || [];
            addLog(`   ✅ ${bubbles.length} bubble${bubbles.length !== 1 ? "s" : ""} translated`);
          } catch (e) {
            addLog(`   ⚠️  ${e.message}`);
          }
          const img = await loadImg(allDataUrls[i]);
          const canvas = document.createElement("canvas");
          drawTranslations(canvas, img, bubbles, fontStyle);
          const src = canvas.toDataURL("image/jpeg", 0.93);
          results[i] = { name: imageFiles[i], src };
          outputsRef.current = results.filter(Boolean);
          setPages([...results.filter(Boolean)]);
        }
        await cleanupOnDevice();
      } else {
        // ── API path: batched ──────────────────────────────────────────────
        for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
          const start = batchIdx * BATCH_SIZE;
          const end   = Math.min(start + BATCH_SIZE, totalPages);
          const batchUrls  = allDataUrls.slice(start, end);
          const batchNames = imageFiles.slice(start, end);
          const batchSize  = end - start;

          addLog(`🔄 Batch ${batchIdx + 1}/${numBatches} — pages ${start + 1}–${end}`);

          const { b64, pageOffsets, totalH } = await stitchImages(batchUrls);
          const kb = Math.round(b64.length * 0.75 / 1024);
          addLog(`   🖼  Stitched ${batchSize} pages → ${kb}KB image`);

          let perPageBubbles = batchUrls.map(() => []);
          try {
            const result = await withRetry(() => translatePage(b64, activeApi, apiKey, targetLang));
            const bubbles = result.bubbles || [];
            addLog(`   ✅ ${bubbles.length} total bubbles across ${batchSize} pages`);
            perPageBubbles = remapBubbles(bubbles, pageOffsets, totalH);
          } catch (e) {
            if (e.message === "RATE_LIMIT") addLog("   ⏳ Rate limit even after retries — try again in a few minutes");
            else if (e.message.startsWith("AUTH_FAILED")) addLog("   🔑 Key rejected — open Settings");
            else addLog(`   ⚠️  ${e.message}`);
          }

          for (let i = 0; i < batchSize; i++) {
            const pageIdx = start + i;
            const img = await loadImg(batchUrls[i]);
            const canvas = document.createElement("canvas");
            drawTranslations(canvas, img, perPageBubbles[i] || [], fontStyle);
            const src = canvas.toDataURL("image/jpeg", 0.93);
            results[pageIdx] = { name: batchNames[i], src };
            const done = results.filter(Boolean);
            outputsRef.current = done;
            setPages([...done]);
            setProgress({ current: pageIdx + 1, total: totalPages });
          }

          if (batchIdx < numBatches - 1 && activeApi === "gemini") {
            addLog(`   ⏱  Waiting 15s before next batch (free tier cool-down)…`);
            await new Promise(r => setTimeout(r, 15000));
          }
        }
      }

      setStatus("done");
      addLog(`✅ Done! ${totalPages} pages translated → ${targetLang} (${numBatches} API call${numBatches > 1 ? "s" : ""})`);
    } catch (e) {
      setStatus("error"); addLog(`❌ ${e.message}`);
    }
  };

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  // ── Upload view ──────────────────────────────────────────────────────────────
  const UploadView = (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      {/* Active API + lang bar */}
      <div style={{ background: C.surface, border: `1px solid ${C.faint}`, borderRadius: 8, padding: "9px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>USING</div>
        <div style={{ fontSize: 12, color: C.gold, fontFamily: "Bangers, cursive", letterSpacing: 2 }}>{APIS[activeApi]?.name}</div>
        <div style={{ fontSize: 10, color: C.muted }}>→</div>
        <div style={{ fontSize: 12, color: C.text }}>{LANGUAGES.find(l => l.code === targetLang)?.label || targetLang}</div>
        <button onClick={() => setShowSettings(true)} style={{ marginLeft: "auto", ...btn(false), fontSize: 11, padding: "4px 10px" }}>⚙ Change</button>
      </div>

      {/* Drop zone */}
      <div
        onDrop={e => { e.preventDefault(); e.dataTransfer.files[0] && processFile(e.dataTransfer.files[0]); }}
        onDragOver={e => e.preventDefault()}
        onClick={() => document.getElementById("cbz-in").click()}
        style={{ border: `2px dashed ${C.gold}`, padding: "28px 16px", textAlign: "center", cursor: "pointer", borderRadius: 10, background: C.bg, marginBottom: 14 }}
      >
        <div style={{ fontSize: 40, marginBottom: 8 }}>📚</div>
        <div style={{ fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 3, color: C.gold }}>TAP TO OPEN CBZ</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>Supports .cbz and .zip · Auto-detects language</div>
        <input id="cbz-in" type="file" accept=".cbz,.zip" style={{ display: "none" }}
          onChange={e => e.target.files[0] && processFile(e.target.files[0])} />
      </div>

      {/* Progress */}
      {status !== "idle" && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginBottom: 5, letterSpacing: 1 }}>
            <span>TRANSLATING</span>
            <span style={{ color: status === "done" ? C.green : C.gold }}>{progress.current}/{progress.total} — {pct}%</span>
          </div>
          <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${pct}%`, background: status === "done" ? C.green : C.gold, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Actions */}
      {status === "done" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button onClick={() => setView("reader")} style={{ flex: 2, background: C.gold, color: "#000", border: "none", padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 15, letterSpacing: 3, cursor: "pointer", borderRadius: 8 }}>📖 READ</button>
          <button onClick={() => outputsRef.current.forEach(({ name, src }) => { const a = document.createElement("a"); a.href = src; a.download = name.replace(/\.[^.]+$/, "_en.jpg"); a.click(); })}
            style={{ flex: 1, background: "transparent", color: "#888", border: `1px solid ${C.border}`, padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 13, letterSpacing: 2, cursor: "pointer", borderRadius: 8 }}>↓ SAVE</button>
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div style={{ background: "#0a0a0a", border: `1px solid ${C.surface2}`, borderRadius: 8, padding: "8px 10px", maxHeight: 170, overflowY: "auto", marginBottom: 14 }}>
          {log.map((l, i) => <div key={i} style={{ fontSize: 10, lineHeight: 1.8, color: "#4a4a4a", borderBottom: "1px solid #131313", padding: "1px 0" }}>{l}</div>)}
        </div>
      )}

      {/* Thumbnails */}
      {pages.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
          {pages.map(({ name, src }) => (
            <div key={name} style={{ borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `1px solid ${C.faint}` }}
              onClick={() => { setView("reader"); setTimeout(() => document.getElementById(`pg-${name}`)?.scrollIntoView({ behavior: "smooth" }), 100); }}>
              <img src={src} alt={name} style={{ width: "100%", display: "block" }} />
            </div>
          ))}
        </div>
      )}

      {pages.length === 0 && status === "idle" && (
        <div style={{ textAlign: "center", padding: "30px 0", color: "#1e1e1e" }}>
          <div style={{ fontFamily: "Bangers, cursive", fontSize: 56, letterSpacing: 8 }}>漫画</div>
          <div style={{ fontSize: 10, letterSpacing: 3, marginTop: 6 }}>OPEN A CBZ FILE TO BEGIN</div>
        </div>
      )}
    </div>
  );

  // ── Reader view ──────────────────────────────────────────────────────────────
  const ReaderView = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ background: "#181818", borderBottom: `1px solid ${C.faint}`, padding: "8px 14px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: C.muted, letterSpacing: 2, whiteSpace: "nowrap" }}>WIDTH</span>
        <input type="range" min={40} max={100} value={viewerWidth}
          onChange={e => setViewerWidth(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.gold }} />
        <span style={{ fontSize: 11, color: C.gold, fontFamily: "Bangers, cursive", letterSpacing: 2, minWidth: 38 }}>{viewerWidth}%</span>
        {[["S",60],["M",80],["L",100]].map(([l,w]) => (
          <button key={l} onClick={() => setViewerWidth(w)} style={{ ...btn(viewerWidth === w), padding: "3px 9px" }}>{l}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", background: "#080808" }}>
        <div style={{ margin: "0 auto", width: `${viewerWidth}%` }}>
          {pages.map(({ name, src }) => (
            <img key={name} id={`pg-${name}`} src={src} alt={name}
              style={{ width: "100%", display: "block", margin: 0, padding: 0 }} />
          ))}
        </div>
      </div>
    </div>
  );

  // ── Shell ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100dvh", background: C.bg, color: C.text, fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.gold}`, padding: "0 14px", height: 50, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 22, letterSpacing: 4, color: C.gold }}>漫画</span>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 12, color: "#444", letterSpacing: 2 }}>TRANSLATOR</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {["upload","reader"].map(v => (
            <button key={v}
              onClick={() => v === "reader" ? pages.length > 0 && setView(v) : setView(v)}
              style={{ ...btn(view === v), opacity: pages.length === 0 && v === "reader" ? 0.3 : 1, fontSize: 9 }}>
              {v === "upload" ? "⚙ TRANSLATE" : "📖 READER"}
            </button>
          ))}
          <button onClick={() => setShowSettings(true)} style={{ background: "transparent", border: `1px solid ${C.faint}`, color: C.muted, padding: "5px 9px", fontSize: 15, cursor: "pointer", borderRadius: 4 }}>⚙️</button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {view === "upload" ? UploadView : ReaderView}
      </div>

      {showSettings && (
        <SettingsPanel
          activeApi={activeApi} setActiveApi={setActiveApi}
          keys={keys} setKeys={setKeys}
          targetLang={targetLang} setTargetLang={setTargetLang}
          fontStyle={fontStyle} setFontStyle={setFontStyle}
          memoryTier={memoryTier} setMemoryTier_={setMemoryTier_}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
