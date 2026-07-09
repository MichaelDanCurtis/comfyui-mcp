# Connections Hub — design

**Status:** spec for sub-project #1 (Connections frame + API Keys). #2–#4 captured as a
sequenced roadmap at the end.
**Date:** 2026-07-08

## Problem

Setting up providers is painful. Credentials (API keys), provider OAuth logins, and custom
MCP servers are configured in scattered places — and today MCP servers only exist inside an
*agent session*, so when the user isn't running an agent (e.g. driving ComfyUI directly, or a
node that needs an external service) those MCPs aren't available.

The user wants a single, app-like surface — launched from the panel's connection dropdown
(`connecting ▾`) — that opens the orchestrator's already-running web console **in an embedded
frame** and lets them manage everything connection-related in one place. This also lays the
foundation for later features (a RunComfy training node, more console "apps").

## Approach (chosen: iframe → console route)

The orchestrator already serves a **loopback web console** (`src/orchestrator/panel-console-http.ts`,
`http://127.0.0.1:9182`) — today read-only (`/`, `GET /api/status`, `/api/vault`,
`/api/photomap`). We extend that console with a credentials page + authenticated write
endpoints, and surface it as an **`<iframe>` overlay** launched from the panel's connection
dropdown. One console page serves both the compact embedded view and the full-page "Advanced"
view — which is exactly the console-as-app-host foundation the later sub-projects build on.

Rejected alternatives: a native panel-drawn modal calling the console API (duplicates the form,
less "app-in-a-frame"); a plain new browser tab (loses the in-panel feel).

## Decomposition & build order

| # | Sub-project | Depends on |
|---|---|---|
| **1** | **Connections frame + API Keys** (this spec) | — |
| 2 | OAuth Logins section (Grok / Codex / Google AI Pro: readiness + server-spawned CLI login) | 1 |
| 3 | MCP Gateway — persistent custom-MCP config, auto-inject into every agent (B) **and** expose tools over HTTP for agent-less consumers (A) + "MCP Servers" management section | 1 |
| 4 | RunComfy exposure + training node — register RunComfy in the gateway so a ComfyUI node can call it agent-less; then build the node | 3 |

#1 establishes the frame, the console's authenticated write surface, and the security model
that #2 and #3 reuse. #3 is load-bearing for #4. Each sub-project gets its own spec → plan →
implementation cycle; #3 (the gateway) warrants its own full brainstorm.

---

# Sub-project #1 — Connections frame + API Keys

## Components

### Console server — `src/orchestrator/panel-console-http.ts`
- `GET /credentials` — a compact, dark-themed, self-contained HTML page (styled to feel
  app-like; matches ComfyUI dark theme). Renders one row per credential slot with a masked
  current value and a paste/save field. Includes an **Advanced** button → `/console`.
- `POST /api/secrets` `{ key, value }` — validates `key` against the credential **allowlist**,
  writes via `panel-secrets`, returns `{ ok, key, masked }`. **Token required.**
- `GET /api/secrets` — returns each allowlisted slot as `{ key, set: bool, masked: "sk-…9f2" }`.
  Never returns full values. **Token required.**
- Response headers on the framed pages: `Content-Security-Policy: frame-ancestors
  http://127.0.0.1:8188 http://localhost:8188`; ensure no `X-Frame-Options: DENY`.
- The existing `/console` full page is the **Advanced** target (already has status/vault/photomap;
  gets a link to `/credentials` too).

### Secrets store — `src/services/panel-secrets.ts` (reuse + extend)
- Already persists provider keys to the per-instance store and hydrates them into agent env.
- Add: `setSecret(key, value)` (allowlist-guarded), `listSecretsMasked()` → slot states.
- Alias fan-out: one UI slot may write several env vars (see slot table).
- After a write: run the existing **hydrate-into-env + re-push readiness/models** path so a
  newly-entered key (e.g. OpenRouter) flips its chip to *ready* live over the bridge.

### Panel — `comfyui-mcp-panel` fork (`web/js/comfyui-mcp-panel.js`)
- In the connection dropdown (`connecting ▾`), add an **"API Keys"** item.
- Clicking it opens a small in-panel overlay containing
  `<iframe src="{consoleUrl}/credentials?token=T">`. `consoleUrl` is already known to the panel
  (orchestrator advertises it; today's default `http://127.0.0.1:9182`).
- `postMessage` contract between page and panel: page posts `{type:"resize", height}` and
  `{type:"close"}`; panel sizes/closes the overlay. **Advanced** opens `{consoleUrl}/console`
  in a new tab (`window.open`).
- Fallback: if the iframe fails to load, the overlay shows the console URL + "open in browser".

## Credential slots (the allowlist)

| Slot (label) | Writes (canonical + aliases) | Powers |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | OpenRouter hosted models |
| Civitai | `CIVITAI_API_TOKEN` | model downloads |
| HuggingFace | `HF_TOKEN`, `HUGGINGFACE_TOKEN` | model downloads |
| Google / Gemini | `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY` | Nano Banana concept images |
| GLM / Zhipu | `GLM_API_KEY`, `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY`, `ZAI_API_KEY` | GLM provider |
| Kimi (API) | `KIMI_API_KEY` | Kimi via API (vs OAuth) |
| RunComfy | `RUNCOMFY_API_KEY` | cloud pods / training (foundation for #4) |
| Comfy Registry | `REGISTRY_ACCESS_TOKEN` | publishing custom nodes |

A `POST /api/secrets` for any key not in this allowlist is rejected (`400`). OAuth-CLI providers
(Grok/Codex/Gemini/Kimi-default) are **not** fields here — the page shows a one-line
"signed in via CLI — see OAuth Logins (coming in #2)" note. xAI / Grok Imagine is OAuth-based
(`grok login`; see `src/services/concept-image-auth.ts`) and has no API-key slot — it belongs to
sub-project #2 (OAuth Logins), not this API-keys page.

## Security model

- Console stays **loopback-bound** (already is).
- `GET`/`POST /api/secrets` require the **orchestrator session token** the panel already holds
  (passed via the iframe `?token=` and echoed on fetches). Prevents any other localhost page
  from reading or writing the user's keys (drive-by/CSRF).
- Keys travel in the **POST body only** (never URLs/query), are **never logged**, and `GET`
  returns **masked** values only (`first4…last3`).
- `frame-ancestors` limited to the ComfyUI origin — no arbitrary embedding.
- This is the user entering their **own** keys into their **own** local app. The implementation
  builds the form; it never transmits keys anywhere but the local secrets store.

## Data flow (set a key)

1. `connecting ▾` → **API Keys** → panel overlay opens `iframe → {consoleUrl}/credentials?token=T`.
2. Page `GET /api/secrets` (token) → renders slots (set/unset, masked).
3. Paste key → Save → `POST /api/secrets {key,value}` (token) → allowlist check → `panel-secrets`
   writes → hydrate-into-env + re-push readiness/models.
4. Masked "saved ✓"; if OpenRouter, its chip flips **ready** live.
5. **Advanced** → `{consoleUrl}/console` in a new tab.

## Error handling (no silent failures)

| Case | Behavior |
|---|---|
| Missing/invalid token | `401`; page: "reconnect the panel" |
| Non-allowlisted key | `400`; rejected, nothing written |
| Store write failure | `500`; key not persisted; error shown |
| Console unreachable (iframe) | overlay fallback: URL + "open in browser" |
| Any value | never logged; `GET` masked only |

## Testing

- **Unit (vitest):** `panel-secrets` — allowlist enforcement, masking format, alias fan-out
  (`HF_TOKEN`→`HUGGINGFACE_TOKEN`, GLM aliases).
- **Console endpoints:** `POST`/`GET /api/secrets` — `401` without token, `400` non-allowlist,
  masked `GET` shape, successful set round-trip.
- **Manual e2e:** open the frame in ComfyUI → set OpenRouter key → OpenRouter chip flips
  *ready*; **Advanced** opens `/console`; iframe-fail fallback renders.

## Scope bounds

**In #1:** frame shell + dropdown launcher, `/credentials` page, `GET`/`POST /api/secrets`,
token auth, `frame-ancestors`, the credential slots above (incl. RunComfy key), masked display,
readiness re-push, Advanced link.

**Out (later specs):** OAuth login triggering (#2), MCP config/gateway/management (#3), RunComfy
API exposure + training node (#4), any general webview framework. OAuth providers get a note
only.

---

# Roadmap — sub-projects #2–#4 (captured, not specced here)

- **#2 OAuth Logins section.** New section in the frame: per-provider readiness (from
  `backend-readiness.ts`) + a "Sign in" button that `POST`s to the orchestrator, which spawns
  the CLI login (`grok`, `codex login`, `gemini`) opening the browser OAuth flow; poll readiness
  until signed in. Providers: Grok, Codex, Google AI Pro (Gemini). Reuses #1's frame + token.
- **#3 MCP Gateway (own brainstorm).** Persistent custom-MCP config store; **(B)** auto-inject
  saved MCP servers into every agent session at spawn; **(A)** an always-on host that exposes
  the configured MCP servers' tools over loopback HTTP so agent-less consumers (ComfyUI nodes,
  the console) can call them. Plus an "MCP Servers" management section in the frame. This is the
  load-bearing piece for #4 and deserves its own full design.
- **#4 RunComfy exposure + training node.** Register the existing RunComfy connector
  (`runcomfy_*` tools) in the gateway so it's reachable with no agent, then build a ComfyUI node
  that calls it for the training API.
