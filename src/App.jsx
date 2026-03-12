import { useState, useRef, useEffect } from "react";

// ─── Font loader ─────────────────────────────────────────────────────────────
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

// ─── JSZip loader ────────────────────────────────────────────────────────────
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const blobToDataUrl = blob => new Promise(res => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob);
});
const loadImg = src => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
});

// ─── Claude API call ──────────────────────────────────────────────────────────
async function translatePage(b64, apiKey) {
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
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          {
            type: "text", text: `You are a manga translator. Analyze this Chinese manga page.

For EVERY piece of Chinese text return:
- x1,y1,x2,y2: TIGHT bounding box around text only (not bubble border), as fraction of image 0.0–1.0
- english: natural English translation matching tone/emotion
- font_size_frac: height of original chars as fraction of image height (0.025 small, 0.04 medium, 0.07 large)
- bg: "white", "black", or "gray"
- align: "center", "left", or "right"
- style: "speech", "shout", "whisper", or "caption"

Return ONLY valid JSON:
{"bubbles":[{"x1":0.1,"y1":0.05,"x2":0.4,"y2":0.15,"english":"Hello!","font_size_frac":0.03,"bg":"white","align":"center","style":"speech"}]}

No Chinese text → {"bubbles":[]}.`
          }
        ]
      }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  let txt = (data.content || []).map(b => b.text || "").join("");
  txt = txt.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(txt); } catch { return { bubbles: [] }; }
}

// Validate key against real API (cheap call, no image)
async function validateKey(apiKey) {
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
      max_tokens: 5,
      messages: [{ role: "user", content: "Hi" }]
    })
  });
  if (res.status === 401) return { ok: false, error: "Invalid API key. Double-check you copied it fully." };
  if (res.status === 403) return { ok: false, error: "Key doesn't have permission. Make sure it's an API key, not an OAuth token." };
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return { ok: false, error: d?.error?.message || `Error ${res.status}` };
  }
  return { ok: true };
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────
function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxW) { line = test; }
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line); return lines;
}
function styleFont(style, size) {
  return (style === "whisper" || style === "caption")
    ? `bold ${size}px 'Comic Neue', cursive` : `${size}px Bangers`;
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
    ctx.textBaseline = "middle";
    ctx.textAlign = b.align || "center";
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

// ─── Colours & shared styles ──────────────────────────────────────────────────
const C = {
  gold: "#d4a017", bg: "#0e0e0e", surface: "#161616",
  surface2: "#1e1e1e", border: "#2a2a2a", text: "#e8e0d0",
  muted: "#555", faint: "#2a2a2a", green: "#4caf50", red: "#e05050",
};

// ─── Onboarding / API key screen ──────────────────────────────────────────────
const STEPS = [
  {
    icon: "🌐",
    title: "Open Anthropic Console",
    desc: "Tap the button below to open console.anthropic.com in your browser. Sign up for free — no credit card needed.",
    action: { label: "Open console.anthropic.com →", url: "https://console.anthropic.com" },
  },
  {
    icon: "🔑",
    title: "Create an API Key",
    desc: 'Once logged in, tap "API Keys" in the left sidebar, then tap "+ Create Key". Give it any name like "Manga App".',
    action: { label: "Go to API Keys →", url: "https://console.anthropic.com/settings/keys" },
  },
  {
    icon: "📋",
    title: "Copy & Paste Your Key",
    desc: 'Copy the key that starts with "sk-ant-…" — it\'s only shown once! Paste it below and tap Verify.',
    action: null,
  },
];

function OnboardingScreen({ onSave }) {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const isLastStep = step === STEPS.length - 1;
  const current = STEPS[step];

  const handleVerify = async () => {
    const trimmed = key.trim();
    if (!trimmed) { setError("Please paste your API key first."); return; }
    if (!trimmed.startsWith("sk-ant-")) {
      setError('Key should start with "sk-ant-…" — make sure you copied the whole thing.');
      return;
    }
    setValidating(true);
    setError("");
    try {
      const result = await validateKey(trimmed);
      if (!result.ok) { setError(result.error); setValidating(false); return; }
      setSuccess(true);
      setTimeout(() => {
        localStorage.setItem("anthropic_api_key", trimmed);
        onSave(trimmed);
      }, 900);
    } catch (e) {
      setError("Network error — check your internet connection and try again.");
      setValidating(false);
    }
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
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 18px" }}>

        {/* Step indicators */}
        <div style={{ display: "flex", gap: 8, marginBottom: 28, justifyContent: "center" }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              height: 4, flex: 1, maxWidth: 80, borderRadius: 2,
              background: i <= step ? C.gold : C.faint,
              transition: "background 0.3s",
            }} />
          ))}
        </div>

        {/* Step card */}
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 22, marginBottom: 20,
        }}>
          <div style={{ fontSize: 42, marginBottom: 12, textAlign: "center" }}>{current.icon}</div>
          <div style={{
            fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 2,
            color: C.gold, marginBottom: 10, textAlign: "center",
          }}>
            STEP {step + 1} — {current.title.toUpperCase()}
          </div>
          <div style={{
            fontSize: 13, color: "#aaa", lineHeight: 1.8,
            textAlign: "center", marginBottom: current.action ? 18 : 0,
          }}>
            {current.desc}
          </div>

          {/* External link button */}
          {current.action && (
            <a
              href={current.action.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block", textAlign: "center",
                background: C.surface2, border: `1px solid ${C.gold}`,
                color: C.gold, padding: "12px 16px", borderRadius: 8,
                fontSize: 12, letterSpacing: 1, textDecoration: "none",
                fontFamily: "Bangers, cursive", fontSize: 14, letterSpacing: 2,
              }}
            >
              {current.action.label}
            </a>
          )}
        </div>

        {/* Key input — only on last step */}
        {isLastStep && (
          <div style={{
            background: C.surface, border: `1px solid ${success ? C.green : error ? C.red : C.border}`,
            borderRadius: 12, padding: 20, marginBottom: 16,
            transition: "border-color 0.2s",
          }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
              PASTE YOUR API KEY
            </div>
            <div style={{ position: "relative", marginBottom: error ? 10 : 16 }}>
              <input
                type={show ? "text" : "password"}
                value={key}
                onChange={e => { setKey(e.target.value); setError(""); setSuccess(false); }}
                placeholder="sk-ant-api03-..."
                autoComplete="off"
                style={{
                  width: "100%", background: C.bg,
                  border: `1px solid ${C.faint}`,
                  borderRadius: 8, padding: "13px 46px 13px 14px",
                  color: C.text, fontSize: 13,
                  fontFamily: "'Courier New', monospace",
                  outline: "none",
                }}
              />
              <button
                onClick={() => setShow(s => !s)}
                style={{
                  position: "absolute", right: 12, top: "50%",
                  transform: "translateY(-50%)",
                  background: "none", border: "none",
                  color: C.muted, cursor: "pointer", fontSize: 18, padding: 0,
                }}
              >{show ? "🙈" : "👁️"}</button>
            </div>

            {error && (
              <div style={{
                background: "#1a0a0a", border: `1px solid ${C.red}33`,
                borderRadius: 6, padding: "10px 12px",
                fontSize: 12, color: C.red, lineHeight: 1.6, marginBottom: 14,
              }}>
                ⚠️ {error}
              </div>
            )}

            {success && (
              <div style={{
                background: "#0a1a0a", border: `1px solid ${C.green}33`,
                borderRadius: 6, padding: "10px 12px",
                fontSize: 12, color: C.green, lineHeight: 1.6, marginBottom: 14,
                textAlign: "center",
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
                cursor: key.trim() && !validating ? "pointer" : "not-allowed",
                borderRadius: 8, transition: "all 0.2s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {validating ? (
                <>
                  <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>
                  VERIFYING…
                </>
              ) : success ? "✅ VERIFIED!" : "VERIFY & SAVE →"}
            </button>
          </div>
        )}

        {/* Navigation */}
        <div style={{ display: "flex", gap: 10 }}>
          {step > 0 && (
            <button
              onClick={() => { setStep(s => s - 1); setError(""); }}
              style={{
                flex: 1, background: "transparent",
                color: C.muted, border: `1px solid ${C.faint}`,
                padding: "12px 0", fontFamily: "Bangers, cursive",
                fontSize: 14, letterSpacing: 2, cursor: "pointer", borderRadius: 8,
              }}
            >
              ← BACK
            </button>
          )}
          {!isLastStep && (
            <button
              onClick={() => setStep(s => s + 1)}
              style={{
                flex: 2, background: C.gold, color: "#000", border: "none",
                padding: "13px 0", fontFamily: "Bangers, cursive",
                fontSize: 15, letterSpacing: 2, cursor: "pointer", borderRadius: 8,
              }}
            >
              NEXT STEP →
            </button>
          )}
        </div>

        {/* Free tier note */}
        {step === 0 && (
          <div style={{
            marginTop: 20, background: C.surface, border: `1px solid ${C.faint}`,
            borderRadius: 10, padding: 16, fontSize: 12, color: C.muted, lineHeight: 1.8,
          }}>
            <div style={{ color: C.gold, fontFamily: "Bangers, cursive", fontSize: 14, letterSpacing: 2, marginBottom: 6 }}>
              💰 IT'S FREE
            </div>
            New Anthropic accounts get <span style={{ color: C.text }}>$5 free credit</span> — enough to translate hundreds of manga pages. No credit card needed to sign up.
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey]     = useState(() => localStorage.getItem("anthropic_api_key") || "");
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
            addLog("   🔑 Key rejected — tap 🔑 in the top bar to re-enter it");
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
    if (confirm("Change your API key?")) {
      localStorage.removeItem("anthropic_api_key");
      setApiKey("");
    }
  };

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  // ── Upload view ──────────────────────────────────────────────────────────
  const UploadView = (
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      {/* Drop zone */}
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

      {/* Progress */}
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
        </div>
      )}

      {/* Action buttons */}
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

      {/* Log */}
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

      {/* Thumbnails */}
      {pages.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {pages.map(({ name, src }) => (
            <div key={name}
              style={{ borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `1px solid ${C.faint}` }}
              onClick={() => {
                setView("reader");
                setTimeout(() => {
                  document.getElementById(`page-${name}`)?.scrollIntoView({ behavior: "smooth" });
                }, 100);
              }}
            >
              <img src={src} alt={name} style={{ width: "100%", display: "block" }} />
            </div>
          ))}
        </div>
      )}

      {pages.length === 0 && status === "idle" && (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#222" }}>
          <div style={{ fontFamily: "Bangers, cursive", fontSize: 64, letterSpacing: 8 }}>漫画</div>
          <div style={{ fontSize: 11, letterSpacing: 3, marginTop: 8 }}>OPEN A CBZ FILE TO BEGIN</div>
        </div>
      )}
    </div>
  );

  // ── Reader view ──────────────────────────────────────────────────────────
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

  // ── Shell ────────────────────────────────────────────────────────────────
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
