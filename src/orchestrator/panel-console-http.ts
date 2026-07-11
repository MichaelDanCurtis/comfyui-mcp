// Loopback HTTP console for MCP / orchestrator settings (control plane).
//
// The ComfyUI sidebar panel stays a canvas-focused client: provider, effort,
// context, storyboards. Service lifecycle, OAuth, MCP mappings, and advanced
// tool suites live here — opened from the panel's Advanced → "Open MCP Console".
//
// Bound to 127.0.0.1 only; never exposed off-host.

import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { allBackendReadiness } from "./backend-readiness.js";
import { listTrainingPacks } from "../services/training-pack.js";
import { getLoraCatalog, loraPreviewsDir } from "../services/lora-catalog.js";
import { photomapHealth } from "../services/photomap.js";
import { setPanelSecret, listPanelSecretsMasked, CREDENTIAL_SLOTS } from "../services/panel-secrets.js";
import { listPrompts, setPromptOverride, clearPromptOverride, isKnownPrompt } from "../services/prompt-overrides.js";
import { logger } from "../utils/logger.js";

const KNOWN_BACKENDS = [
  "claude",
  "codex",
  "chatgpt",
  "gemini",
  "grok",
  "glm",
  "kimi",
  "ollama",
] as const;

export interface PanelConsoleHttpServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const FRAME_ANCESTORS = "frame-ancestors http://127.0.0.1:8188 http://localhost:8188 'self'";
function sendFramedHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy": FRAME_ANCESTORS,
  });
  res.end(html);
}

function tokenOk(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true; // no token configured → open (dev)
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams.get("token");
    const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    return q === expected || h === expected;
  } catch { return false; }
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    let oversized = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c) => {
      if (oversized) return; // already over limit: drain and discard the rest, don't destroy mid-stream
      data += c;
      if (data.length > 1_000_000) {
        oversized = true;
        data = "";
        settle(() => reject(new Error("body too large")));
      }
    });
    req.on("end", () => { settle(() => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } }); });
    req.on("error", (e) => { settle(() => reject(e)); });
    req.on("close", () => { settle(() => reject(new Error("request closed before body was fully received"))); });
  });
}

const PREVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function serveLoraPreview(req: IncomingMessage, res: ServerResponse): void {
  let id = "";
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    id = (url.searchParams.get("id") ?? "").trim();
  } catch {
    sendJson(res, 400, { ok: false, error: "bad request" });
    return;
  }
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id required" });
    return;
  }
  const catalog = getLoraCatalog();
  const entry = catalog.get(id);
  if (!entry?.previewFile) {
    sendJson(res, 404, { ok: false, error: "no preview" });
    return;
  }
  const previewsRoot = resolve(loraPreviewsDir());
  const abs = resolve(join(previewsRoot, entry.previewFile));
  if (!abs.startsWith(previewsRoot + "/") && abs !== previewsRoot) {
    sendJson(res, 403, { ok: false, error: "invalid preview path" });
    return;
  }
  if (!existsSync(abs)) {
    sendJson(res, 404, { ok: false, error: "preview file missing" });
    return;
  }
  const mime = PREVIEW_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=3600",
  });
  createReadStream(abs).pipe(res);
}

function consoleLandingHtml(opts: {
  bridgePort: number;
  consolePort: number;
  comfyuiUrl: string;
}): string {
  const { bridgePort, consolePort, comfyuiUrl } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ComfyUI MCP Console</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; line-height: 1.5; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.25rem; }
    .sub { color: #9aa0a6; font-size: 0.9rem; margin-bottom: 1.5rem; }
    section { background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
    h2 { font-size: 0.95rem; margin: 0 0 0.6rem; color: #c4c7ce; }
    ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
    li { margin: 0.25rem 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    pre { background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
    .ok { color: #81c995; }
    .warn { color: #fdd663; }
    a { color: #8ab4f8; }
    #status { font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>ComfyUI MCP Console</h1>
    <p class="sub">Control plane for the panel orchestrator — MCP servers, OAuth, and service settings. The ComfyUI sidebar panel stays focused on chat, providers, and the live canvas.</p>

    <section>
      <h2>Connection</h2>
      <p>Bridge <code>ws://127.0.0.1:${bridgePort}</code> · ComfyUI <code>${escapeHtml(comfyuiUrl)}</code></p>
      <p id="status">Loading provider readiness…</p>
    </section>

    <section>
      <h2>Vault &amp; PhotoMap</h2>
      <p id="vault-status">Loading vault…</p>
      <ul>
        <li><code>GET /api/vault</code> — LoRA catalog + training packs</li>
        <li><code>GET /api/lora-preview?id=…</code> — LoRA preview image</li>
        <li><code>GET /api/photomap</code> — PhotoMapAI health</li>
      </ul>
    </section>

    <section>
      <h2>Coming here (panel stays in ComfyUI)</h2>
      <ul>
        <li>Start / stop / restart orchestrator</li>
        <li>MCP server mappings &amp; inherited <code>~/.claude.json</code> tools</li>
        <li>OAuth &amp; API provider sign-in</li>
        <li>LoRA library UI, mapper wizard, Apple Photos (Face G)</li>
        <li>A2UI-rich tool surfaces</li>
      </ul>
    </section>

    <section>
      <h2>Stays in the ComfyUI panel</h2>
      <ul>
        <li>Provider / model / effort pickers &amp; context window meter</li>
        <li>Video storyboards &amp; live graph edits</li>
        <li>Connect / Disconnect to this bridge</li>
      </ul>
    </section>

    <section>
      <h2>API</h2>
      <pre>GET /api/status
GET /api/vault
GET /api/photomap</pre>
    </section>
  </main>
  <script>
    fetch('/api/status').then(r => r.json()).then(d => {
      const el = document.getElementById('status');
      const rows = (d.backends || []).map(b =>
        b.backend + ': ' + (b.ready ? 'ready' : (b.cli ? 'sign in' : 'install CLI'))
      ).join(' · ');
      el.innerHTML = '<span class="ok">Orchestrator running</span> — ' + (rows || 'no backends');
    }).catch(() => {
      document.getElementById('status').innerHTML = '<span class="warn">Could not load status</span>';
    });
    fetch('/api/vault').then(r => r.json()).then(d => {
      const el = document.getElementById('vault-status');
      if (!d.ok) { el.textContent = 'Vault unavailable'; return; }
      el.innerHTML = 'LoRA catalog: <strong>' + d.lora_count + '</strong> entries · ' +
        'Training packs: <strong>' + d.training_pack_count + '</strong>';
    }).catch(() => {
      const el = document.getElementById('vault-status');
      if (el) el.textContent = 'Vault status unavailable';
    });
  </script>
</body>
</html>`;
}

function credentialsHtml(
  slots: { id: string; label: string; help?: string }[],
  consoleUrl: string,
  token: string,
): string {
  const rows = slots
    .map(
      (s) => `      <div class="row" data-slot="${escapeHtml(s.id)}">
        <div class="meta"><span class="label">${escapeHtml(s.label)}</span>${s.help ? `<span class="help">${escapeHtml(s.help)}</span>` : ""}</div>
        <div class="state"><span class="badge" data-badge>—</span></div>
        <div class="entry"><input type="password" placeholder="Paste key…" data-input autocomplete="off" spellcheck="false" /><button data-save>Save</button></div>
      </div>`,
    )
    .join("\n");
  const cfg = JSON.stringify({ consoleUrl, token });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Keys</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; }
    main { padding: 0.9rem 1rem 1.2rem; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0; }
    .close { background: none; border: none; color: #9aa0a6; font-size: 1.1rem; cursor: pointer; }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 0.6rem; padding: 0.6rem 0; border-bottom: 1px solid #23272f; }
    .meta { display: flex; flex-direction: column; }
    .label { font-size: 0.9rem; font-weight: 500; }
    .help { font-size: 0.72rem; color: #9aa0a6; }
    .state { grid-column: 2; align-self: center; }
    .badge { font-size: 0.72rem; color: #9aa0a6; }
    .badge.set { color: #81c995; }
    .entry { grid-column: 1 / -1; display: flex; gap: 0.4rem; }
    input { flex: 1; background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 7px; color: #e8eaed; padding: 0.4rem 0.5rem; font-size: 0.82rem; }
    button { background: #2a3140; border: 1px solid #3a4150; color: #e8eaed; border-radius: 7px; padding: 0.4rem 0.7rem; font-size: 0.82rem; cursor: pointer; }
    button:hover { background: #333c4d; }
    button[data-save].ok { color: #81c995; border-color: #2f6b41; }
    footer { margin-top: 0.9rem; display: flex; justify-content: space-between; align-items: center; }
    .advanced { background: none; border: 1px solid #2a2f3a; color: #8ab4f8; }
    .err { color: #f28b82; font-size: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <header><h1>API Keys</h1><button class="close" data-close title="Close">✕</button></header>
    <div id="rows">
${rows}
    </div>
    <p class="err" id="err"></p>
    <footer>
      <span class="help">Stored locally, per instance. Values never leave this machine.</span>
      <button class="advanced" data-advanced>Advanced ↗</button>
    </footer>
  </main>
  <script>
    const CFG = ${cfg};
    const q = (t) => "?token=" + encodeURIComponent(t);
    function postHeight() {
      try { parent.postMessage({ type: "resize", height: document.body.scrollHeight }, "*"); } catch {}
    }
    async function load() {
      try {
        const r = await fetch("/api/secrets" + q(CFG.token));
        const d = await r.json();
        for (const s of (d.slots || [])) {
          const row = document.querySelector('.row[data-slot="' + s.id + '"]');
          if (!row) continue;
          const badge = row.querySelector("[data-badge]");
          badge.textContent = s.set ? "set · " + s.masked : "not set";
          badge.classList.toggle("set", !!s.set);
        }
      } catch (e) { document.getElementById("err").textContent = "Could not load status — reconnect the panel."; }
      postHeight();
    }
    document.querySelectorAll(".row").forEach((row) => {
      const btn = row.querySelector("[data-save]");
      const input = row.querySelector("[data-input]");
      btn.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          const r = await fetch("/api/secrets" + q(CFG.token), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ slot: row.dataset.slot, value }),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || "save failed");
          input.value = "";
          const badge = row.querySelector("[data-badge]");
          badge.textContent = "set · " + d.masked; badge.classList.add("set");
          btn.textContent = "Saved ✓"; btn.classList.add("ok");
          setTimeout(() => { btn.textContent = "Save"; btn.classList.remove("ok"); btn.disabled = false; }, 1500);
        } catch (e) {
          document.getElementById("err").textContent = String(e.message || e);
          btn.textContent = "Save"; btn.disabled = false;
        }
      });
    });
    document.querySelector("[data-close]").addEventListener("click", () => { try { parent.postMessage({ type: "close" }, "*"); } catch {} });
    document.querySelector("[data-advanced]").addEventListener("click", () => { window.open(CFG.consoleUrl + "/console", "_blank", "noopener"); });
    window.addEventListener("load", load);
    new ResizeObserver(postHeight).observe(document.body);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Server-rendered "edit every prompt" page (opened from the panel). Same-origin, so
// its fetches to /api/prompts need no CORS. Each prompt shows its effective text in a
// textarea with Save + Reset; empty/Reset restores the built-in default (the store
// never discards it), so a bad edit is always one click from recovery. The embedded
// script uses string concatenation (not template literals) so it can live inside this
// outer template literal without escaping headaches.
function promptsHtml(token: string): string {
  const cfg = JSON.stringify({ token });
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Prompts</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:14px 16px;background:#0f1115;color:#e8eaed;font:13px/1.5 system-ui,sans-serif}
  h1{font-size:16px;margin:0 0 2px}
  .sub{opacity:.6;font-size:12px;margin-bottom:12px}
  .p{border:1px solid #2a2f3a;border-radius:10px;padding:10px 12px;margin-bottom:12px;background:#141821}
  .phead{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .plabel{font-weight:600;flex:1}
  .badge{font-size:11px;padding:1px 7px;border-radius:10px;background:#263042;opacity:.85}
  .badge.ov{background:#3a2f14;color:#f6c453}
  .help{opacity:.55;font-size:11px;margin:0 0 6px}
  textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;background:#0b0d12;border:1px solid #333;color:#ddd;border-radius:6px;padding:8px;font:12px/1.45 ui-monospace,Menlo,monospace}
  .row{display:flex;gap:8px;margin-top:6px;align-items:center}
  button{padding:6px 12px;border-radius:6px;border:1px solid #333;background:#1c2331;color:#e8eaed;cursor:pointer}
  button.reset{background:transparent;opacity:.8}
  .ok{color:#7ee081}.err{color:#f28b82}
  .status{font-size:11px;margin-left:auto;opacity:.85}
</style></head><body>
  <h1>Agent Prompts</h1>
  <div class="sub">Edit any prompt the orchestrator controls. Empty or <b>Reset</b> restores the built-in default — a bad edit is always one click from recovery.</div>
  <div id="err" class="err" style="display:none;margin-bottom:8px"></div>
  <div id="list">Loading…</div>
  <script>
    const CFG=${cfg};
    const q="?token="+encodeURIComponent(CFG.token);
    const list=document.getElementById("list"), errEl=document.getElementById("err");
    const esc=(s)=>String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});
    function card(p){
      const d=document.createElement("div"); d.className="p";
      d.innerHTML='<div class="phead"><span class="plabel">'+esc(p.label)+'</span><span class="badge '+(p.overridden?"ov":"")+'" data-badge>'+(p.overridden?"custom":"default")+'</span></div>'
        +(p.help?'<p class="help">'+esc(p.help)+'</p>':'')
        +'<textarea spellcheck="false"></textarea>'
        +'<div class="row"><button data-save>Save</button><button class="reset" data-reset>Reset to default</button><span class="status" data-status></span></div>';
      const ta=d.querySelector("textarea"), badge=d.querySelector("[data-badge]"), status=d.querySelector("[data-status]");
      ta.value = p.override!=null ? p.override : p.default;
      const setState=(pp)=>{ badge.textContent=pp.overridden?"custom":"default"; badge.classList.toggle("ov",!!pp.overridden); };
      d.querySelector("[data-save]").onclick=async()=>{
        status.textContent="saving…"; status.className="status";
        try{ const r=await fetch("/api/prompts"+q,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:p.id,value:ta.value})});
          const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.error||"save failed");
          setState(j.prompt||{overridden:!!ta.value.trim()}); status.textContent="saved ✓"; status.className="status ok";
        }catch(e){ status.textContent=String(e.message||e); status.className="status err"; }
      };
      d.querySelector("[data-reset]").onclick=async()=>{
        status.textContent="resetting…"; status.className="status";
        try{ const r=await fetch("/api/prompts"+q,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:p.id,reset:true})});
          const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.error||"reset failed");
          ta.value=(j.prompt&&j.prompt.default)||p.default; setState(j.prompt||{overridden:false}); status.textContent="reset ✓"; status.className="status ok";
        }catch(e){ status.textContent=String(e.message||e); status.className="status err"; }
      };
      return d;
    }
    (async()=>{ try{ const r=await fetch("/api/prompts"+q); const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.error||"load failed");
      list.innerHTML=""; for(const p of (j.prompts||[])) list.appendChild(card(p)); if(!list.children.length) list.textContent="No prompts registered.";
    }catch(e){ list.textContent=""; errEl.style.display="block"; errEl.textContent="Couldn't load prompts — reconnect the panel. ("+String(e.message||e)+")"; } })();
  </script></body></html>`;
}

export function startPanelConsoleHttpServer(opts: {
  port: number;
  host?: string;
  bridgePort: number;
  comfyuiUrl: string;
  token?: string;
}): Promise<PanelConsoleHttpServer> {
  const host = opts.host ?? "127.0.0.1";

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/secrets") {
      // CORS: the panel now edits credentials NATIVELY (a section in its Advanced
      // box) instead of the same-origin iframe console, so the browser fetches this
      // cross-origin (ComfyUI :8188 → console :9182). Reflect the Origin and answer
      // the preflight. Still token-gated + loopback-bound, so reflecting any origin
      // is safe — a page without the random per-session token just gets 401.
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (!tokenOk(req, opts.token)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      if (req.method === "GET") { sendJson(res, 200, { ok: true, slots: listPanelSecretsMasked() }); return; }
      if (req.method === "POST") {
        let body: any;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
        const slot = String(body?.slot ?? "");
        const value = String(body?.value ?? "");
        if (!slot || !value) { sendJson(res, 400, { ok: false, error: "slot and value required" }); return; }
        try {
          setPanelSecret(slot, value);
          const masked = listPanelSecretsMasked().find((s) => s.id === slot)?.masked ?? null;
          sendJson(res, 200, { ok: true, slot, masked });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, /unknown credential slot/i.test(msg) ? 400 : 500, { ok: false, error: msg });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (path === "/api/prompts") {
      if (!tokenOk(req, opts.token)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      if (req.method === "GET") { sendJson(res, 200, { ok: true, prompts: listPrompts() }); return; }
      if (req.method === "POST") {
        let body: any;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
        const id = String(body?.id ?? "");
        if (!id || !isKnownPrompt(id)) { sendJson(res, 400, { ok: false, error: "unknown prompt id" }); return; }
        if (body?.reset === true) clearPromptOverride(id);
        else setPromptOverride(id, String(body?.value ?? ""));
        sendJson(res, 200, { ok: true, prompt: listPrompts().find((p) => p.id === id) ?? null });
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (req.method === "POST" && path === "/api/ai/model-card") {
      // Loopback-only (like /api/status) — runs a one-shot Claude proposal over the
      // provided evidence; no secrets read/written, so no token gate. Model Explorer
      // (ComfyUI, localhost) calls this to distill messy metadata into a proposal.
      let body: any;
      try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
      const evidence = body?.evidence ?? body;
      if (!evidence || typeof evidence !== "object" || !evidence.filename) {
        sendJson(res, 400, { ok: false, error: "evidence with filename required" }); return;
      }
      try {
        const { proposeModelCard } = await import("./ai-proposer.js");
        const { proposal, raw } = await proposeModelCard(evidence, body?.model);
        sendJson(res, proposal ? 200 : 502, {
          ok: !!proposal, proposal,
          ...(proposal ? {} : { error: "model did not return valid JSON", raw: raw.slice(0, 600) }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: msg });
      }
      return;
    }
    if (req.method === "GET" && path === "/api/status") {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const liveUrl = `http://${host}:${boundPort}`;
      sendJson(res, 200, {
        ok: true,
        console_url: liveUrl,
        bridge_port: opts.bridgePort,
        bridge_url: `ws://${host}:${opts.bridgePort}`,
        comfyui_url: opts.comfyuiUrl,
        backends,
        any_ready,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/vault") {
      try {
        const catalog = getLoraCatalog();
        const loras = catalog.list({ limit: 500 });
        const packs = listTrainingPacks();
        sendJson(res, 200, {
          ok: true,
          lora_count: loras.length,
          loras: loras.slice(0, 50).map((e) => ({
            id: e.id,
            displayName: e.displayName,
            relPath: e.relPath,
            missing: !!e.missing,
            civitaiVersionId: e.civitaiVersionId,
          })),
          training_pack_count: packs.length,
          training_packs: packs.slice(0, 20),
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (req.method === "GET" && path === "/api/lora-preview") {
      serveLoraPreview(req, res);
      return;
    }
    if (req.method === "GET" && path === "/api/photomap") {
      try {
        const health = await photomapHealth();
        sendJson(res, 200, { reachable: true, ...health });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (req.method === "GET" && path === "/credentials") {
      if (!tokenOk(req, opts.token)) { sendHtml(res, 401, "<p>Unauthorized — reconnect the panel.</p>"); return; }
      const bound = server.address();
      const boundPort = bound && typeof bound === "object" ? bound.port : opts.port;
      sendFramedHtml(res, 200, credentialsHtml(CREDENTIAL_SLOTS, `http://${host}:${boundPort}`, opts.token ?? ""));
      return;
    }
    if (req.method === "GET" && path === "/prompts") {
      if (!tokenOk(req, opts.token)) { sendHtml(res, 401, "<p>Unauthorized — reconnect the panel.</p>"); return; }
      sendFramedHtml(res, 200, promptsHtml(opts.token ?? ""));
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/console")) {
      sendHtml(
        res,
        200,
        consoleLandingHtml({
          bridgePort: opts.bridgePort,
          consolePort: opts.port,
          comfyuiUrl: opts.comfyuiUrl,
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      logger.info(`[panel-console] MCP console listening on ${url} (loopback)`);
      resolve({
        port: boundPort,
        url,
        stop: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}