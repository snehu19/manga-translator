import { useState, useRef, useEffect } from "react";

// ─── Font loader ──────────────────────────────────────────────────────────────
async function loadMangaFont() {
  if (!document.getElementById("manga-font-link")) {
    const link = document.createElement("link");
    link.id = "manga-font-link";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@700&display=swap";
    document.head.appendChild(link);
  }
  try {
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load("24px Bangers"),
        document.fonts.load("bold 24px 'Comic Neue'"),
      ]);
    } else {
      await new Promise(r => setTimeout(r, 1800));
    }
  } catch {}
}

// ─── JSZip loader ─────────────────────────────────────────────────────────────
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

// ─── Gemini API call ──────────────────────────────────────────────────────────
// Using gemini-2.0-flash-lite: free, no credit card, 1000 req/day
const GEMINI_MODEL = "gemini-2.0-flash-lite";

async function translatePage(b64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: b64,
            }
          },
          {
            text: `You are a manga translator. Analyze this Chinese manga page.

For EVERY piece of Chinese text return:
- x1,y1,x2,y2: TIGHT bounding box around text characters ONLY (not bubble border), as fraction of image 0.0–1.0
- english: natural English translation matching tone/emotion
- font_size_frac: height of original characters as fraction of image height (0.025 small, 0.04 medium, 0.07 large)
- bg: "white", "black", or "gray"
- align: "center", "left", or "right"
- style: "speech", "shout", "whisper", or "caption"

Return ONLY valid JSON, no markdown:
{"bubbles":[{"x1":0.1,"y1":0.05,"x2":0.4,"y2":0.15,"english":"Hello!","font_size_frac":0.03,"bg":"white","align":"center","style":"speech"}]}

No Chinese text on page → {"bubbles":[]}.`
          }
        ]
      }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && msg.includes("API_KEY")) throw new Error("AUTH_FAILED:" + msg);
    if (res.status === 403) throw new Error("AUTH_FAILED: API key invalid or not enabled.");
    if (res.status === 429) throw new Error("RATE_LIMIT: Free daily limit reached. Try again tomorrow.");
    throw new Error(msg);
  }

  const data = await res.json();
  let txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  txt = txt.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(txt); } catch { return { bubbles: [] }; }
}

// Validate key with a tiny text-only request (no image needed, very cheap)
async function validateKey(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hi" }] }],
        generationConfig: { maxOutputTokens: 5 }
      })
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 400 || res.status === 403) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, error: d?.error?.message || "Invalid API key." };
    }
    return { ok: false, error: `Unexpected error (${res.status}). Check your internet and try again.` };
  } catch (e) {
    return { ok: false, error: "Network error — check your internet connection." };
  }
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────
function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxW) line = test;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}
function styleFont(style, size) {
  return (style === "whisper" || style === "caption")
    ? `bold ${size}px 'Comic Neue', cursive`
    : `${size}px Bangers`;
}
function fitFont(ctx, text, bw, bh, style, hintPx) {
  const maxSz = Math.min(hintPx * 1.5, bh * 0.9, 80);
  for (let sz = Math.round(maxSz); sz >= 7; sz--) {
    ctx.font = styleFont(style, sz);
    const pad = Math.max(3, sz * 0.25);
    const ls = wrapText(ctx, text, bw - pad * 2);
    const tH = ls.length * sz * 1.2;
    const mW = Math.max(...ls.map(l => ctx.measureText(l).width));
    if (tH <= bh - pad * 2 && mW <= bw - pad * 2) return { size: sz, lines: ls, lineH: sz * 1.2, pad };
  }
  ctx.font = styleFont(style, 7);
  return { size: 7, lines: wrapText(ctx, text, bw - 6), lineH: 8.4, pad: 3 };
}
function drawTranslations(canvas, img, bubbles) {
  const ctx = canvas.getContext("2d");
  canvas.width = img.width; canvas.height = img.height;
  ctx.drawImage(img, 0, 0);
  for (const b of bubbles) {
    if (!b.english) continue;
    const x1 = Math.round(b.x1 * img.width), y1 = Math.round(b.y1 * img.height);
    const x2 = Math.round(b.x2 * img.width), y2 = Math.round(b.y2 * img.height);
    const bw = x2 - x1, bh = y2 - y1;
    if (bw < 8 || bh < 8) continue;
    const isDark = b.bg === "black" || b.bg === "dark";
    const style = b.style || "speech";
    ctx.fillStyle = isDark ? "#000" : style === "caption" ? "#f4efdf" : "#fff";
    ctx.fillRect(x1, y1, bw, bh);
    const hintPx = b.font_size_frac ? Math.round(b.font_size_frac * img.height) : Math.round(bh * 0.4);
    const { size, lines, lineH, pad } = fitFont(ctx, b.english, bw, bh, style, hintPx);
    ctx.font = styleFont(style, size);
    ctx.fillStyle = isDark ? "#fff" : "#111";
    ctx.textBaseline = "middle"; ctx.textAlign = b.align || "center";
    if (style === "shout") {
      ctx.shadowColor = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)";
      ctx.shadowBlur = 1.5; ctx.shadowOffsetX = 0.8; ctx.shadowOffsetY = 0.8;
    } else { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; }
    const totalH = lines.length * lineH;
    let curY = y1 + pad + (bh - pad * 2 - totalH) / 2 + lineH / 2;
    const tx = b.align === "right" ? x2 - pad : b.align === "left" ? x1 + pad : x1 + bw / 2;
    for (const line of lines) { ctx.fillText(line, tx, curY, bw - pad * 2); curY += lineH; }
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  }
}

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  gold: "#d4a017", bg: "#0e0e0e", surface: "#161616",
  surface2: "#1e1e1e", border: "#2a2a2a", text: "#e8e0d0",
  muted: "#555", faint: "#2a2a2a", green: "#4caf50", red: "#e05050",
  blue: "#4a90d9",
};

// ─── Onboarding ───────────────────────────────────────────────────────────────
const STEPS = [
  {
    icon: "🌐",
    title: "Open Google AI Studio",
    body: "Google gives you a completely free API key — no credit card, no billing setup needed. Tap the button below to open AI Studio.",
    note: "✅ 100% free  ·  No credit card  ·  1,000 pages/day",
    btn: { label: "Open aistudio.google.com →", url: "https://aistudio.google.com" },
  },
  {
    icon: "🔑",
    title: "Get Your API Key",
    body: 'Once you\'re signed in with your Google account, tap "Get API key" in the left sidebar, then tap "Create API key". Copy the key that appears.',
    note: "💡 It looks like: AIzaSy...",
    btn: { label: "Go directly to API Keys →", url: "https://aistudio.google.com/app/apikey" },
  },
  {
    icon: "📋",
    title: "Paste & Verify",
    body: "Paste your key below. We'll send one test request to make sure it works before saving.",
    note: null,
    btn: null,
  },
];

function OnboardingScreen({ onSave }) {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const cur = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleVerify = async () => {
    const trimmed = key.trim();
    if (!trimmed) { setError("Paste your API key first."); return; }
    if (!trimmed.startsWith("AIza")) {
      setError('Google API keys start with "AIza…" — make sure you copied the full key.');
      return;
    }
    setValidating(true); setError("");
    const result = await validateKey(trimmed);
    if (!result.ok) { setError(result.error); setValidating(false); return; }
    setSuccess(true);
    setTimeout(() => {
      localStorage.setItem("gemini_api_key", trimmed);
      onSave(trimmed);
    }, 900);
  };

  return (
    <div style={{
      height: "100dvh", background: C.bg, color: C.text,
      fontFamily: "'Courier New', monospace",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        background: C.surface, borderBottom: `2px solid ${C.gold}`,
        padding: "0 18px", height: 50,
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 24, letterSpacing: 4, color: C.gold }}>漫画</span>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 13, color: C.muted, letterSpacing: 2 }}>TRANSLATOR</span>
        <span style={{
          marginLeft: "auto", background: "#0a2a0a", border: `1px solid ${C.green}44`,
          color: C.green, fontSize: 9, letterSpacing: 1, padding: "3px 8px", borderRadius: 20,
        }}>● FREE — NO CARD NEEDED</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 18px 32px" }}>

        {/* Progress dots */}
        <div style={{ display: "flex", gap: 8, marginBottom: 28, justifyContent: "center" }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              height: 4, flex: 1, maxWidth: 72, borderRadius: 2,
              background: i <= step ? C.gold : C.faint,
              transition: "background 0.3s",
            }} />
          ))}
        </div>

        {/* Step card */}
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 14, padding: 22, marginBottom: 16,
        }}>
          <div style={{ fontSize: 46, textAlign: "center", marginBottom: 12 }}>{cur.icon}</div>
          <div style={{
            fontFamily: "Bangers, cursive", fontSize: 19, letterSpacing: 2,
            color: C.gold, textAlign: "center", marginBottom: 12,
          }}>
            STEP {step + 1} / {STEPS.length} — {cur.title.toUpperCase()}
          </div>
          <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.85, textAlign: "center", marginBottom: cur.note || cur.btn ? 16 : 0 }}>
            {cur.body}
          </div>

          {cur.note && (
            <div style={{
              background: "#0a1a0a", border: `1px solid ${C.green}33`,
              borderRadius: 8, padding: "8px 14px",
              fontSize: 12, color: C.green, textAlign: "center", marginBottom: cur.btn ? 14 : 0,
            }}>
              {cur.note}
            </div>
          )}

          {cur.btn && (
            <a href={cur.btn.url} target="_blank" rel="noopener noreferrer" style={{
              display: "block", textAlign: "center",
              background: C.surface2, border: `1px solid ${C.gold}`,
              color: C.gold, padding: "13px 16px", borderRadius: 8,
              fontSize: 14, letterSpacing: 1, textDecoration: "none",
              fontFamily: "Bangers, cursive", letterSpacing: 2,
            }}>
              {cur.btn.label}
            </a>
          )}
        </div>

        {/* Key input — step 3 only */}
        {isLast && (
          <div style={{
            background: C.surface,
            border: `1px solid ${success ? C.green : error ? C.red : C.border}`,
            borderRadius: 14, padding: 20, marginBottom: 16,
            transition: "border-color 0.2s",
          }}>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
              PASTE YOUR GEMINI API KEY
            </div>
            <div style={{ position: "relative", marginBottom: 12 }}>
              <input
                type={show ? "text" : "password"}
                value={key}
                onChange={e => { setKey(e.target.value); setError(""); setSuccess(false); }}
                placeholder="AIzaSy..."
                autoComplete="off"
                style={{
                  width: "100%", background: C.bg,
                  border: `1px solid ${C.faint}`, borderRadius: 8,
                  padding: "13px 46px 13px 14px",
                  color: C.text, fontSize: 13,
                  fontFamily: "'Courier New', monospace", outline: "none",
                }}
              />
              <button onClick={() => setShow(s => !s)} style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: 0,
              }}>{show ? "🙈" : "👁️"}</button>
            </div>

            {error && (
              <div style={{
                background: "#1a0a0a", border: `1px solid ${C.red}33`,
                borderRadius: 8, padding: "10px 12px",
                fontSize: 12, color: C.red, lineHeight: 1.7, marginBottom: 12,
              }}>
                ⚠️ {error}
              </div>
            )}

            {success && (
              <div style={{
                background: "#0a1a0a", border: `1px solid ${C.green}33`,
                borderRadius: 8, padding: "10px 12px",
                fontSize: 12, color: C.green, textAlign: "center", marginBottom: 12,
              }}>
                ✅ Key verified! Opening app…
              </div>
            )}

            <button
              onClick={handleVerify}
              disabled={validating || !key.trim() || success}
              style={{
                width: "100%",
                background: success ? C.green : key.trim() && !validating ? C.gold : C.faint,
                color: success || (key.trim() && !validating) ? "#000" : C.muted,
                border: "none", padding: "14px 0",
                fontFamily: "Bangers, cursive", fontSize: 16, letterSpacing: 3,
                cursor: key.trim() && !validating && !success ? "pointer" : "not-allowed",
                borderRadius: 8, transition: "all 0.2s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {validating
                ? <><span style={{ display: "inline-block", animation: "spin 0.8s linear infinite" }}>⟳</span> VERIFYING…</>
                : success ? "✅ VERIFIED!"
                : "VERIFY & SAVE →"}
            </button>
          </div>
        )}

        {/* Nav buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          {step > 0 && (
            <button onClick={() => { setStep(s => s - 1); setError(""); }} style={{
              flex: 1, background: "transparent", color: C.muted,
              border: `1px solid ${C.faint}`, padding: "12px 0",
              fontFamily: "Bangers, cursive", fontSize: 14, letterSpacing: 2,
              cursor: "pointer", borderRadius: 8,
            }}>← BACK</button>
          )}
          {!isLast && (
            <button onClick={() => setStep(s => s + 1)} style={{
              flex: 2, background: C.gold, color: "#000", border: "none",
              padding: "13px 0", fontFamily: "Bangers, cursive",
              fontSize: 15, letterSpacing: 2, cursor: "pointer", borderRadius: 8,
            }}>NEXT →</button>
          )}
        </div>

        {/* Powered by note */}
        <div style={{
          marginTop: 24, textAlign: "center",
          fontSize: 10, color: "#333", lineHeight: 1.8,
        }}>
          Powered by Google Gemini 2.0 Flash Lite<br/>
          Free tier · No credit card · 1,000 pages/day
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey]     = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [view, setView]         = useState("upload");
  const [pages, setPages]       = useState([]);
  const [status, setStatus]     = useState("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [log, setLog]           = useState([]);
  const [fontReady, setFontReady] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(100);
  const outputsRef = useRef([]);
  const readerRef  = useRef(null);

  useEffect(() => { loadMangaFont().then(() => setFontReady(true)); }, []);

  if (!apiKey) return <OnboardingScreen onSave={setApiKey} />;

  const addLog = msg => setLog(l => [...l, msg]);

  const processFile = async file => {
    if (!fontReady) await loadMangaFont();
    setStatus("loading"); setLog([]); setPages([]); outputsRef.current = [];
    try {
      const JSZip = await loadJSZip();
      addLog("📦 Extracting archive…");
      const zip = await JSZip.loadAsync(file);
      const imageFiles = Object.keys(zip.files)
        .filter(n => /\.(jpg|jpeg|png)$/i.test(n) && !zip.files[n].dir).sort();

      setProgress({ current: 0, total: imageFiles.length });
      addLog(`🖼  Found ${imageFiles.length} pages`);
      const results = [];

      for (let i = 0; i < imageFiles.length; i++) {
        const name = imageFiles[i];
        setProgress({ current: i + 1, total: imageFiles.length });
        addLog(`🔄 [${i+1}/${imageFiles.length}] ${name}`);

        const blob    = await zip.files[name].async("blob");
        const dataUrl = await blobToDataUrl(blob);
        const b64     = dataUrl.split(",")[1];
        const img     = await loadImg(dataUrl);

        let bubbles = [];
        try {
          const r = await translatePage(b64, apiKey);
          bubbles = r.bubbles || [];
          addLog(`   ✅ ${bubbles.length} bubble${bubbles.length !== 1 ? "s" : ""}`);
        } catch (e) {
          if (e.message.startsWith("AUTH_FAILED")) {
            addLog("   🔑 Key rejected — tap 🔑 to re-enter it");
          } else if (e.message.startsWith("RATE_LIMIT")) {
            addLog("   ⏳ Daily free limit hit — resumes tomorrow (resets midnight PT)");
          } else {
            addLog(`   ⚠️  ${e.message}`);
          }
        }

        const canvas = document.createElement("canvas");
        drawTranslations(canvas, img, bubbles);
        const src = canvas.toDataURL("image/jpeg", 0.93);
        results.push({ name, src });
        outputsRef.current = [...results];
        setPages([...results]);

        // Small delay to avoid hitting rate limits (15 RPM = 4s between requests)
        if (i < imageFiles.length - 1) await new Promise(r => setTimeout(r, 4100));
      }

      setStatus("done");
      addLog(`✅ Done — ${imageFiles.length} pages translated`);
    } catch (e) {
      setStatus("error");
      addLog(`❌ ${e.message}`);
    }
  };

  const handleDrop = e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  };

  const downloadAll = () =>
    outputsRef.current.forEach(({ name, src }) => {
      const a = document.createElement("a");
      a.href = src; a.download = name.replace(/\.[^.]+$/, "_en.jpg"); a.click();
    });

  const clearKey = () => {
    if (confirm("Change your Gemini API key?")) {
      localStorage.removeItem("gemini_api_key");
      setApiKey("");
    }
  };

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  // ── Upload view ────────────────────────────────────────────────────────────
  const UploadView = (
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      <div
        onDrop={handleDrop} onDragOver={e => e.preventDefault()}
        onClick={() => document.getElementById("cbz-in").click()}
        style={{
          border: `2px dashed ${C.gold}`, padding: "32px 16px",
          textAlign: "center", cursor: "pointer", borderRadius: 10,
          background: C.bg, marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 44, marginBottom: 8 }}>📚</div>
        <div style={{ fontFamily: "Bangers, cursive", fontSize: 22, letterSpacing: 3, color: C.gold }}>
          TAP TO OPEN CBZ
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>or drag and drop</div>
        <input id="cbz-in" type="file" accept=".cbz,.zip" style={{ display: "none" }}
          onChange={e => e.target.files[0] && processFile(e.target.files[0])} />
      </div>

      {status !== "idle" && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 6, letterSpacing: 1 }}>
            <span>TRANSLATING</span>
            <span style={{ color: status === "done" ? C.green : C.gold }}>
              {progress.current}/{progress.total} — {pct}%
            </span>
          </div>
          <div style={{ height: 4, background: "#222", borderRadius: 2 }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: status === "done" ? C.green : C.gold,
              borderRadius: 2, transition: "width 0.3s",
            }} />
          </div>
          {status === "loading" && (
            <div style={{ fontSize: 10, color: "#444", marginTop: 5, letterSpacing: 1 }}>
              ⏱ ~4s between pages to stay within free rate limits
            </div>
          )}
        </div>
      )}

      {status === "done" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button onClick={() => setView("reader")} style={{
            flex: 2, background: C.gold, color: "#000", border: "none",
            padding: "14px 0", fontFamily: "Bangers, cursive",
            fontSize: 16, letterSpacing: 3, cursor: "pointer", borderRadius: 8,
          }}>📖 READ MANGA</button>
          <button onClick={downloadAll} style={{
            flex: 1, background: "transparent", color: "#888",
            border: `1px solid ${C.border}`, padding: "14px 0",
            fontFamily: "Bangers, cursive", fontSize: 14,
            letterSpacing: 2, cursor: "pointer", borderRadius: 8,
          }}>↓ SAVE</button>
        </div>
      )}

      {log.length > 0 && (
        <div style={{
          background: "#0a0a0a", border: `1px solid ${C.surface2}`,
          borderRadius: 8, padding: "10px 12px",
          maxHeight: 200, overflowY: "auto", marginBottom: 16,
        }}>
          {log.map((l, i) => (
            <div key={i} style={{ fontSize: 11, lineHeight: 1.8, color: "#4a4a4a", borderBottom: "1px solid #141414", padding: "1px 0" }}>{l}</div>
          ))}
        </div>
      )}

      {pages.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {pages.map(({ name, src }) => (
            <div key={name}
              style={{ borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `1px solid ${C.faint}` }}
              onClick={() => {
                setView("reader");
                setTimeout(() => document.getElementById(`page-${name}`)?.scrollIntoView({ behavior: "smooth" }), 100);
              }}
            >
              <img src={src} alt={name} style={{ width: "100%", display: "block" }} />
            </div>
          ))}
        </div>
      )}

      {pages.length === 0 && status === "idle" && (
        <div style={{ textAlign: "center", padding: "36px 0", color: "#222" }}>
          <div style={{ fontFamily: "Bangers, cursive", fontSize: 60, letterSpacing: 8 }}>漫画</div>
          <div style={{ fontSize: 11, letterSpacing: 3, marginTop: 8 }}>OPEN A CBZ FILE TO BEGIN</div>
        </div>
      )}
    </div>
  );

  // ── Reader view ────────────────────────────────────────────────────────────
  const ReaderView = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        background: "#181818", borderBottom: `1px solid ${C.faint}`,
        padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: C.muted, letterSpacing: 2, whiteSpace: "nowrap" }}>WIDTH</span>
        <input
          type="range" min={40} max={100} value={viewerWidth}
          onChange={e => setViewerWidth(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.gold, cursor: "pointer" }}
        />
        <span style={{ fontSize: 12, color: C.gold, fontFamily: "Bangers, cursive", letterSpacing: 2, minWidth: 40 }}>
          {viewerWidth}%
        </span>
        {[["S", 60], ["M", 80], ["L", 100]].map(([label, w]) => (
          <button key={label} onClick={() => setViewerWidth(w)} style={{
            background: viewerWidth === w ? C.gold : "transparent",
            color: viewerWidth === w ? "#000" : C.muted,
            border: `1px solid ${viewerWidth === w ? C.gold : C.faint}`,
            padding: "4px 10px", fontSize: 11, cursor: "pointer",
            fontFamily: "'Courier New', monospace", borderRadius: 3,
          }}>{label}</button>
        ))}
      </div>
      <div ref={readerRef} style={{ flex: 1, overflowY: "auto", background: "#0a0a0a" }}>
        <div style={{ margin: "0 auto", width: `${viewerWidth}%` }}>
          {pages.map(({ name, src }) => (
            <img key={name} id={`page-${name}`} src={src} alt={name}
              style={{ width: "100%", display: "block", margin: 0, padding: 0 }} />
          ))}
          {pages.length === 0 && (
            <div style={{ textAlign: "center", padding: "80px 20px", color: "#222" }}>
              <div style={{ fontFamily: "Bangers, cursive", fontSize: 48 }}>漫画</div>
              <div style={{ fontSize: 11, letterSpacing: 3, marginTop: 8 }}>No pages yet</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── Shell ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      height: "100dvh", background: C.bg, color: C.text,
      fontFamily: "'Courier New', monospace",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{
        background: C.surface, borderBottom: `2px solid ${C.gold}`,
        padding: "0 14px", height: 50,
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
      }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 22, letterSpacing: 4, color: C.gold }}>漫画</span>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 13, color: "#444", letterSpacing: 2 }}>TRANSLATOR</span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {["upload", "reader"].map(v => (
            <button key={v}
              onClick={() => v === "reader" ? pages.length > 0 && setView(v) : setView(v)}
              style={{
                background: view === v ? C.gold : "transparent",
                color: view === v ? "#000" : pages.length === 0 && v === "reader" ? "#333" : "#666",
                border: `1px solid ${view === v ? C.gold : C.faint}`,
                padding: "5px 10px", fontSize: 9, letterSpacing: 1,
                cursor: pages.length === 0 && v === "reader" ? "not-allowed" : "pointer",
                fontFamily: "'Courier New', monospace", borderRadius: 3,
              }}
            >{v === "upload" ? "⚙ TRANSLATE" : "📖 READER"}</button>
          ))}
          <button onClick={clearKey} title="Change API key" style={{
            background: "transparent", border: `1px solid ${C.faint}`,
            color: C.muted, padding: "5px 8px", fontSize: 14,
            cursor: "pointer", borderRadius: 3,
          }}>🔑</button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {view === "upload" ? UploadView : ReaderView}
      </div>
    </div>
  );
}
