# Agent platform — morning verification checklist

Use this after reloading ComfyUI (hard refresh the frontend) and restarting the panel orchestrator so you pick up the latest panel JS + `comfyui-mcp` build.

**Local paths (this machine)**

| Service | URL |
|---------|-----|
| ComfyUI | http://127.0.0.1:9500 |
| Agent bridge | ws://127.0.0.1:9180 |
| MCP Console | http://127.0.0.1:9182/ |
| ComfyUI data | `/Users/michaelcurtis/Documents/ComfyUI` |
| Panel source | `~/Documents/ComfyUI/custom_nodes/comfyui-agent-panel/` |
| Orchestrator | `npx comfyui-mcp --panel-orchestrator` (or `npm link` local build) |

**Before you start**

1. `npm run build` in `comfyui-mcp` (if you pulled new commits).
2. Reload ComfyUI browser tab (Cmd+Shift+R).
3. Connect the Agent panel (Claude or another provider).
4. Optional: `lora_catalog_sync` once if LoRA list may be stale.

---

## Phase 0 — Per-workflow agent (workspace picker)

### UI

- [ ] **Workspace bar** appears under the Agent header.
- [ ] **Current workspace** shows the active tab name.
- [ ] With **two workflow tabs open**, pin the non-active tab → agent edits that tab while you stay on the other (add a node via agent; check the background tab).
- [ ] Reconnect panel → pin survives (orchestrator re-sync).

### Agent tools

- [ ] `panel_list_workflows` — lists open tabs.
- [ ] `panel_set_workflow_target` mode `pinned` + `panel_get_workflow_target` — returns pinned path.
- [ ] `panel_set_workflow_target` mode `current` — follows your active tab again.

### Pinned edge cases (fixed overnight — please confirm)

- [ ] **Save pinned tab**: pin workflow B, ask agent to `panel_save_workflow` → saves **B**, not the tab you're viewing.
- [ ] **Load onto pinned tab**: pin B, `panel_load_workflow(pack:…)` or path load → graph appears on **B** without switching your view.
- [ ] **Run while pinned**: pin B, `panel_run` → agent gets a **clear error** (must switch tab or use Current workspace). This is expected — ComfyUI only queues the visible tab.
- [ ] **Screenshot / enter subgraph while pinned** → clear error, no wrong canvas capture.

### Known limitation (not a bug)

- Pinning a workflow whose graph is **not exposed** on this ComfyUI build (`wf.graph` missing) still errors — use **Current workspace** or switch to that tab.

---

## Phase 0b — LoRA manager

### Catalog (orchestrator / MCP)

- [ ] `lora_catalog_sync` — picks up on-disk LoRAs.
- [ ] `lora_catalog_list` / `lora_catalog_search` — metadata + keywords.
- [ ] If [ComfyUI LoRA Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) installed: `lora_catalog_import_sidecars` fills triggers/previews.
- [ ] `lora_catalog_set_preview` or sidecar import → preview file under `~/.comfyui-mcp/instances/<slug>/lora-previews/`.

### Panel UI

- [ ] Ask agent: **"Open the LoRA manager"** → full-panel overlay, search, preview thumbnails.
- [ ] Previews load (need MCP console reachable — **Open MCP Console** link works; `GET /api/lora-preview?id=…` returns image).
- [ ] Ask: **"Let me pick a LoRA"** / `panel_pick_lora` → select card → **Use this LoRA** → agent receives `relPath`, keywords, strength hints.
- [ ] Multi-pick: agent uses `allow_multiple: true` → confirm returns array.

### Agent apply

- [ ] After pick, agent wires **LoraLoader** with correct `rel_path` and prompt keywords.

---

## Phase 1 — Grok backend

- [ ] Provider chip includes **Grok**.
- [ ] `grok` CLI signed in (`~/.grok/auth.json`) → chip shows ready (not "Not signed in").
- [ ] Switch to Grok, send a message → agent replies.
- [ ] Optional: `COMFYUI_MCP_GROK_MODEL` if you use a non-default model.

---

## Phase 2 — Cross-provider concept images (headless MCP)

No panel UI — verify via agent or `npx comfyui-mcp` stdio tools.

### Grok Imagine

- [ ] `grok login` / OAuth at `~/.grok/auth.json`.
- [ ] `fetch_concept_image` provider `grok`, simple prompt → temp file + `comfy_filename` in ComfyUI `input/`.

### Google Nano Banana

- [ ] `GEMINI_API_KEY` set (or Gemini CLI OAuth).
- [ ] `fetch_concept_image` provider `google` → image lands in `input/`.

### Workflow wiring

- [ ] `apply_reference_to_workflow` on a small test graph (LoadImage / Qwen edit slot) → correct node widget updated.
- [ ] Skill `structure-map-concept` — agent can follow structure-map → Qwen/Krea pipeline (smoke: read skill + one end-to-end concept).

---

## Phase 3 — AI Toolkit supervisor (headless MCP)

- [ ] `AI_TOOLKIT_ROOT` / `AI_TOOLKIT_URL` point at a running AI Toolkit install.
- [ ] `toolkit_status` — health + version.
- [ ] `toolkit_list_models` — non-empty if toolkit configured.
- [ ] `toolkit_run_job` — submit a trivial job (or dry validation only if you prefer not to run GPU work overnight).

---

## Phase 4 — RunComfy connector (headless MCP)

Requires `RUNCOMFY_API_KEY` + `RUNCOMFY_USER_ID`.

- [ ] `runcomfy_list_pods` — returns your pods (or empty list without error).
- [ ] `runcomfy_sync_workflow` — upload/sync a small workflow JSON to a pod (if you have a pod).
- [ ] `runcomfy_queue` — queue on pod (optional — costs $).
- [ ] Optional trainer tools: `runcomfy_trainer_*` if you use RunComfy training.

---

## Phase 5 — Multi-workflow pipeline (headless MCP)

- [ ] Create a minimal YAML manifest (see `docs/design/workflow-pipeline.md`).
- [ ] `run_workflow_pipeline` with `dry_run: true` — stages resolve, no execution.
- [ ] `run_workflow_pipeline` live — one stage enqueues and completes (or fails with actionable error).

Note: pipeline uses **headless enqueue**, not panel graph tools — no workspace pin interaction.

---

## MCP Console (control plane)

- [ ] Panel → **Open MCP Console** → http://127.0.0.1:9182/
- [ ] Landing page loads; **Connection** shows bridge + ComfyUI URL.
- [ ] `GET /api/status` — backends list, readiness flags.
- [ ] `GET /api/vault` — LoRA count + training packs summary.
- [ ] `GET /api/photomap` — PhotoMapAI reachable or explicit `reachable: false`.

---

## PhotoMap / vault (agent-driven, no dedicated panel UI yet)

- [ ] PhotoMapAI running (if you use it) — `photomap_curate_sync` succeeds.
- [ ] `vault_create_training_pack` — pack appears in `GET /api/vault`.
- [ ] `vault_list_training_pack_images` — lists curated images.

---

## Regression smoke (5 minutes)

- [ ] Connect panel → send "read my graph" → `panel_get_graph` card in activity.
- [ ] Queue a simple workflow on **current** tab → image card appears in chat.
- [ ] `/reload` or soft reload → session resumes.
- [ ] Download tray still updates on `download_model`.

---

## If something fails

| Symptom | Likely cause |
|---------|----------------|
| LoRA previews blank | MCP console not running or wrong `console_url`; check Network tab for `/api/lora-preview` 404 |
| Pin edits wrong tab | Workspace still **Current**; agent must call `panel_set_workflow_target` or you pick pin in UI |
| `panel_run` while pinned errors | **Expected** — switch to pinned tab or Current workspace before run |
| Grok 403 / not ready | Run `grok` login locally |
| Concept image 401 | Grok/Gemini auth not configured |
| RunComfy tools fail | Missing `RUNCOMFY_*` env on orchestrator process |

---

## Commits (overnight session)

- **comfyui-mcp** `feat/agent-platform`: LoRA preview HTTP + tests; this verification doc; roadmap status updates.
- **comfyui-agent-panel** (local): LoRA manager UI, `console_url`, workspace picker, pinned `workflow_path` fixes for save/load/rename/close/run guards.

Panel push to `artokun/comfyui-mcp-panel` may still 403 — local custom node is authoritative until push access is fixed.