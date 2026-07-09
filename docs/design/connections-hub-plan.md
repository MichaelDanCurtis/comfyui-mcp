# Connections Hub #1 (Frame + API Keys) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded, app-like credentials frame launched from the panel's connection dropdown, so the user sets all API keys in one place, backed by the existing secrets store.

**Architecture:** Extend the orchestrator's loopback web console (`panel-console-http.ts`) with a token-gated `/credentials` page + `GET`/`POST /api/secrets`, writing through the existing `panel-secrets` service (whose change events already trigger readiness re-push). The panel (fork) adds an "API Keys" dropdown item that opens the console page in an `<iframe>` overlay. An "Advanced" button opens the full `/console`.

**Tech Stack:** TypeScript (Node `http`, orchestrator), vanilla JS (panel front-end), vitest.

## Global Constraints

- Console binds **127.0.0.1 only** (already true) — never change the bind host.
- Secret **values never logged**; `GET` returns masked only (`first4…last3`); keys travel in POST body, never URL/query.
- Every secret key is validated against an **allowlist** on both save and load — reject non-allowlisted (`400`).
- `/credentials` + `/api/secrets` require the **console token**; without it → `401`.
- Panel repo is the fork `MichaelDanCurtis/comfyui-mcp-panel`, branch `feat/grok-provider`; installed at `~/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/` (ComfyUI serves `web/js/comfyui-mcp-panel.js`; needs Cmd+Shift+R to reload).
- comfyui-mcp repo work is on branch `feat/connections-hub`.
- Node ≥ 22.

---

### Task 1: Credential slots + secret facade (`panel-secrets.ts`)

**Files:**
- Modify: `src/services/panel-secrets.ts`
- Test: `src/__tests__/services/panel-secrets-slots.test.ts`

**Interfaces:**
- Produces: `CREDENTIAL_SLOTS: CredentialSlot[]` where `CredentialSlot = { id: string; label: string; envKeys: string[]; store: "comfyui" | "agent"; help?: string }`; `setPanelSecret(slotId: string, value: string): void`; `listPanelSecretsMasked(): { id: string; label: string; set: boolean; masked: string | null }[]`; `maskSecret(v: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/services/panel-secrets-slots.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

describe("panel-secrets credential slots", () => {
  beforeEach(() => {
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    for (const k of ["OPENROUTER_API_KEY","XAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","HF_TOKEN","HUGGINGFACE_TOKEN","GLM_API_KEY","ZHIPU_API_KEY","ZHIPUAI_API_KEY","ZAI_API_KEY","KIMI_API_KEY","RUNCOMFY_API_KEY","REGISTRY_ACCESS_TOKEN","CIVITAI_API_TOKEN"]) delete process.env[k];
  });

  it("fans a slot out to all its env keys in the right store file", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("huggingface", "hf_abc123456789");
    const file = JSON.parse(readFileSync(process.env.COMFYUI_MCP_PANEL_SECRETS!, "utf-8"));
    expect(file.comfyuiEnv.HF_TOKEN).toBe("hf_abc123456789");
    expect(file.comfyuiEnv.HUGGINGFACE_TOKEN).toBe("hf_abc123456789");
  });

  it("routes a provider slot to the agent store and hydrates env", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("glm", "glm-secret-xyz789");
    const file = JSON.parse(readFileSync(process.env.COMFYUI_MCP_PANEL_SECRETS!, "utf-8"));
    expect(file.agentEnv.GLM_API_KEY).toBe("glm-secret-xyz789");
    expect(process.env.GLM_API_KEY).toBe("glm-secret-xyz789");
  });

  it("rejects an unknown slot", async () => {
    const m = await import("../../services/panel-secrets.js");
    expect(() => m.setPanelSecret("not-a-slot", "x")).toThrow(/unknown credential slot/i);
  });

  it("lists masked state without leaking values", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("openrouter", "sk-or-v1-abcdef123456");
    const rows = m.listPanelSecretsMasked();
    const or = rows.find((r) => r.id === "openrouter")!;
    expect(or.set).toBe(true);
    expect(or.masked).toBe("sk-o…456");
    expect(JSON.stringify(rows)).not.toContain("abcdef");
    const civ = rows.find((r) => r.id === "civitai")!;
    expect(civ.set).toBe(false);
    expect(civ.masked).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/services/panel-secrets-slots.test.ts`
Expected: FAIL (`setPanelSecret` not exported).

- [ ] **Step 3: Extend the allowlists**

In `src/services/panel-secrets.ts`, extend the two existing arrays (keep existing entries):

```ts
export const COMFYUI_SECRET_ENV_ALLOWLIST = [
  "CIVITAI_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_TOKEN",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "RUNCOMFY_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
] as const;

export const AGENT_SECRET_ENV_ALLOWLIST = [
  "OPENROUTER_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "ZHIPUAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
] as const;
```

- [ ] **Step 4: Add the slot model + facade**

Append to `src/services/panel-secrets.ts`:

```ts
export interface CredentialSlot {
  id: string;
  label: string;
  envKeys: string[];
  store: "comfyui" | "agent";
  help?: string;
}

/** UI credential slots. Each slot writes ALL its envKeys (alias fan-out) into its
 *  store. `store` decides which allowlist/setter applies. */
export const CREDENTIAL_SLOTS: CredentialSlot[] = [
  { id: "openrouter", label: "OpenRouter", envKeys: ["OPENROUTER_API_KEY"], store: "agent", help: "Hosted models (MiMo, MiniMax, GPT, Claude…)" },
  { id: "glm", label: "GLM / Zhipu", envKeys: ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY"], store: "agent", help: "GLM provider" },
  { id: "kimi", label: "Kimi (API)", envKeys: ["KIMI_API_KEY"], store: "agent", help: "Kimi via API key (vs its OAuth)" },
  { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "google", label: "Google / Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], store: "comfyui", help: "Nano Banana concept images" },
  { id: "xai", label: "xAI", envKeys: ["XAI_API_KEY"], store: "comfyui", help: "Grok Imagine concept images" },
  { id: "runcomfy", label: "RunComfy", envKeys: ["RUNCOMFY_API_KEY"], store: "comfyui", help: "Cloud pods / training" },
  { id: "registry", label: "Comfy Registry", envKeys: ["REGISTRY_ACCESS_TOKEN"], store: "comfyui", help: "Publishing custom nodes" },
];

const SLOT_BY_ID = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s]));

/** Mask a secret for display: first 4 + ellipsis + last 3. Short values fully masked. */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
}

/** Set every env key of a slot (alias fan-out) into its store. Throws on unknown slot. */
export function setPanelSecret(slotId: string, value: string): void {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const set = slot.store === "agent" ? setAgentSecret : setComfyuiSecret;
  for (const key of slot.envKeys) set(key, value);
}

/** Masked per-slot state: set = the slot's PRIMARY (first) env key has a stored value. */
export function listPanelSecretsMasked(): { id: string; label: string; set: boolean; masked: string | null }[] {
  const comfyui = loadComfyuiSecretEnv();
  const agent = loadAgentSecretEnv();
  return CREDENTIAL_SLOTS.map((slot) => {
    const store = slot.store === "agent" ? agent : comfyui;
    const primary = slot.envKeys[0];
    const val = store[primary];
    return { id: slot.id, label: slot.label, set: !!val, masked: val ? maskSecret(val) : null };
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/services/panel-secrets-slots.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/panel-secrets.ts src/__tests__/services/panel-secrets-slots.test.ts
git commit -m "feat(secrets): credential slots + setPanelSecret facade with alias fan-out"
```

---

### Task 2: Token-gated `/api/secrets` endpoints (`panel-console-http.ts`)

**Files:**
- Modify: `src/orchestrator/panel-console-http.ts`
- Test: `src/__tests__/orchestrator/console-secrets.test.ts`

**Interfaces:**
- Consumes: `setPanelSecret`, `listPanelSecretsMasked`, `CREDENTIAL_SLOTS` (Task 1).
- Produces: `startPanelConsoleHttpServer` now accepts `token?: string`; routes `GET /api/secrets`, `POST /api/secrets`, and gates them + `/credentials` on the token.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/orchestrator/console-secrets.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";

const TOKEN = "test-console-token";
let srv: PanelConsoleHttpServer;
const base = () => srv.url;

describe("console /api/secrets", () => {
  beforeEach(async () => {
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    srv = await startPanelConsoleHttpServer({ port: 0, bridgePort: 9180, comfyuiUrl: "http://127.0.0.1:8188", token: TOKEN });
  });
  afterEach(async () => { await srv.stop(); });

  it("401s without the token", async () => {
    const r = await fetch(`${base()}/api/secrets`);
    expect(r.status).toBe(401);
  });

  it("lists masked slots with the token", async () => {
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slots.find((s: any) => s.id === "openrouter")).toBeTruthy();
    expect(body.slots.every((s: any) => s.masked === null || typeof s.masked === "string")).toBe(true);
  });

  it("sets a key and reflects it masked; rejects unknown slot", async () => {
    const ok = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_123456789" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).masked).toBe("civ_…789");

    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", value: "x" }),
    });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/orchestrator/console-secrets.test.ts`
Expected: FAIL (`token` option / routes absent).

- [ ] **Step 3: Add token option + secrets routes**

In `panel-console-http.ts`: add `token?: string` to the `startPanelConsoleHttpServer` opts type and to the `opts` object. Add these imports at the top:

```ts
import { setPanelSecret, listPanelSecretsMasked } from "../services/panel-secrets.js";
```

Add a token check helper near `sendJson`:

```ts
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
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
```

Inside the `createServer` handler, BEFORE the `/api/status` block, add:

```ts
if (path === "/api/secrets") {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/orchestrator/console-secrets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/panel-console-http.ts src/__tests__/orchestrator/console-secrets.test.ts
git commit -m "feat(console): token-gated GET/POST /api/secrets"
```

---

### Task 3: `/credentials` page + `frame-ancestors` (`panel-console-http.ts`)

**Files:**
- Modify: `src/orchestrator/panel-console-http.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_SLOTS` (Task 1), token gate (Task 2).
- Produces: `GET /credentials` (token-gated) returns the compact HTML page; framed pages send `Content-Security-Policy: frame-ancestors …`.

- [ ] **Step 1: Add a frame-ancestors-aware HTML sender**

In `panel-console-http.ts`, add:

```ts
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
```

- [ ] **Step 2: Add the credentials page builder**

Add `credentialsHtml(slots, consoleUrl, token)` that renders one row per slot (label, help, masked current value, password input, Save button), plus an **Advanced** button linking to `/console`, and a `<script>` that: `GET /api/secrets?token=` to populate masked state; on Save `POST`s `{slot,value}` with the token and shows "saved ✓"; posts `{type:"resize",height}` and a close button posts `{type:"close"}` to `window.parent`. Dark theme mirroring `consoleLandingHtml`'s `<style>`. (Reuse the existing `<style>` block; keep it self-contained — no external assets, per CSP.)

- [ ] **Step 3: Route it (token-gated, framed)**

Add before the `/` route:

```ts
if (req.method === "GET" && path === "/credentials") {
  if (!tokenOk(req, opts.token)) { sendHtml(res, 401, "<p>Unauthorized — reconnect the panel.</p>"); return; }
  const bound = server.address();
  const boundPort = bound && typeof bound === "object" ? bound.port : opts.port;
  sendFramedHtml(res, 200, credentialsHtml(CREDENTIAL_SLOTS, `http://${host}:${boundPort}`, opts.token ?? ""));
  return;
}
```

- [ ] **Step 4: Manual check**

Run (temporary): `COMFYUI_URL=http://127.0.0.1:8188 node -e "import('./dist/orchestrator/panel-console-http.js').then(async m=>{const s=await m.startPanelConsoleHttpServer({port:9188,bridgePort:9180,comfyuiUrl:'http://127.0.0.1:8188',token:'t'});console.log(s.url)})"` then `curl -s 'http://127.0.0.1:9188/credentials?token=t' | grep -c OpenRouter` → expect `≥1`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9188/credentials` → expect `401`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/panel-console-http.ts
git commit -m "feat(console): compact /credentials page + frame-ancestors for panel embedding"
```

---

### Task 4: Mint console token + advertise it to the panel (`index.ts`)

**Files:**
- Modify: `src/orchestrator/index.ts` (near the `startPanelConsoleHttpServer` call, ~line 1063; and the bridge readiness/hello push)

**Interfaces:**
- Consumes: `startPanelConsoleHttpServer({..., token})` (Task 2).
- Produces: a `consoleToken` (randomUUID) passed to the console; the panel receives `console_url` + `console_token` via the existing bridge push that already sends readiness (so the panel can build the iframe URL). No new secret-change wiring — `onAgentSecretsChanged`/`onComfyuiSecretsChanged` already re-push readiness.

- [ ] **Step 1: Mint + pass the token**

Before the `startPanelConsoleHttpServer({` call, add `const consoleToken = randomUUID();` (import `randomUUID` from `node:crypto` if not already), and add `token: consoleToken,` to the options object.

- [ ] **Step 2: Advertise console info to the panel**

Find where the orchestrator pushes readiness/hello to a connected tab (grep `bridge.push` with a readiness/`console_url` payload near the tab-connect handler). Add `console_url` and `console_token: consoleToken` to that payload object (the panel reads them to build the iframe src). If readiness and console info are separate pushes, add a one-line `bridge.push({ type: "console", console_url: panelConsoleHttp.url, console_token: consoleToken }, tabId)` in the tab-connect handler.

- [ ] **Step 3: Build + smoke**

Run: `npm run build` (expect exit 0). Restart the orchestrator (`node dist/index.js connect http://127.0.0.1:8188`), then `curl -s http://127.0.0.1:9182/api/status | grep -o console_url` → expect a hit; confirm the log line still prints the console URL.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/index.ts
git commit -m "feat(orchestrator): mint console token and advertise console_url/token to the panel"
```

---

### Task 5: Panel "API Keys" dropdown item + iframe overlay (fork)

**Files:**
- Modify: `~/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js` (on branch `feat/grok-provider`)

**Interfaces:**
- Consumes: `console_url` + `console_token` from the bridge `console`/readiness message (Task 4).
- Produces: an "API Keys" entry in the connection dropdown that opens the overlay.

- [ ] **Step 1: Capture console info from the bridge**

In the bridge message handler (grep the file for where readiness/`console_url` messages are handled, near the `connecting` pill logic ~line 4400+), store `state.consoleUrl` and `state.consoleToken` when a message carries them.

- [ ] **Step 2: Add the dropdown item + overlay**

In the connection dropdown renderer (grep for the `connecting`/status menu that shows the Bridge URL), add an **"API Keys"** button. Its click handler builds and shows a fixed-position overlay:

```js
function openCredentialsFrame() {
  if (!state.consoleUrl || !state.consoleToken) { alert("Connect the panel first — console not advertised yet."); return; }
  const backdrop = document.createElement("div");
  backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  const frame = document.createElement("iframe");
  frame.src = `${state.consoleUrl}/credentials?token=${encodeURIComponent(state.consoleToken)}`;
  frame.style.cssText = "width:420px;max-width:92vw;height:520px;max-height:88vh;border:1px solid #2a2f3a;border-radius:12px;background:#0f1115;box-shadow:0 12px 48px rgba(0,0,0,.5);";
  const onMsg = (e) => {
    if (!state.consoleUrl || e.origin !== new URL(state.consoleUrl).origin) return;
    if (e.data?.type === "resize" && e.data.height) frame.style.height = Math.min(e.data.height + 8, window.innerHeight * 0.88) + "px";
    if (e.data?.type === "close") close();
  };
  function close() { window.removeEventListener("message", onMsg); backdrop.remove(); }
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  window.addEventListener("message", onMsg);
  backdrop.appendChild(frame);
  document.body.appendChild(backdrop);
}
```

Wire the "API Keys" button's `onclick` to `openCredentialsFrame`. (The page's own **Advanced** button opens `/console` in a new tab via `window.open` from inside the iframe — no panel code needed.)

- [ ] **Step 3: Validate + reload**

Run: `node --check "~/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js"` (expect no output). Hard-refresh ComfyUI (Cmd+Shift+R).

- [ ] **Step 4: Commit + push (fork)**

```bash
cd ~/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel
git add web/js/comfyui-mcp-panel.js
git commit -m "feat(panel): API Keys item in connection dropdown → credentials frame"
git push fork feat/grok-provider
```

---

### Task 6: End-to-end verification

- [ ] **Step 1:** With the rebuilt orchestrator running and ComfyUI hard-refreshed, open the connection dropdown → click **API Keys** → the overlay iframe loads the credentials page (all 9 slots visible, masked state populated).
- [ ] **Step 2:** Paste a real **OpenRouter** key → Save → page shows "saved ✓ (masked)"; within a moment the **OpenRouter chip flips to ready** in the panel (confirms `setAgentSecret` → hydrate → readiness re-push).
- [ ] **Step 3:** Click **Advanced** → `/console` opens in a new tab showing status/vault/photomap.
- [ ] **Step 4:** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9182/api/secrets` → `401` (token enforced).
- [ ] **Step 5:** Confirm no secret value appears in the orchestrator log (`grep -i sk-or /tmp/fork-orchestrator.log` → no match).

---

## Roadmap (separate specs/plans later)
- **#2 OAuth Logins** — frame section: readiness + server-spawned `grok`/`codex login`/`gemini`.
- **#3 MCP Gateway** — persistent custom-MCP config + auto-inject into agents + always-on HTTP tool exposure (own brainstorm).
- **#4 RunComfy exposure + training node** — register RunComfy in the gateway; build the node.
