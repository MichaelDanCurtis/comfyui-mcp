#!/usr/bin/env node
/**
 * Headless verification of the agent-platform phases against a live ComfyUI.
 * Read-only / non-destructive: presence-checks phase tools, then calls the safe
 * read-only ones and reports PASS / CLEAN-FAIL (expected error) / MISSING.
 *
 * Usage: COMFYUI_URL=http://127.0.0.1:8188 node scripts/verify-agent-platform.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const COMFYUI_PATH =
  process.env.COMFYUI_PATH ?? "/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: {
    ...process.env,
    COMFYUI_URL,
    COMFYUI_PATH,
    COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
    COMFYUI_MCP_AUTOUPDATE: "0",
    LOG_LEVEL: "error",
  },
});

const mcp = new Client({ name: "agent-platform-verify", version: "0.0.0" });
await mcp.connect(transport);
const { tools } = await mcp.listTools();
const names = new Set(tools.map((t) => t.name));

// Phase → expected tools
const PHASES = {
  "0  per-workflow target": ["panel_get_workflow_target", "panel_set_workflow_target", "panel_list_workflows"],
  "0b LoRA catalog": ["lora_catalog_sync", "lora_catalog_list", "lora_catalog_get", "lora_catalog_search", "lora_catalog_upsert", "lora_catalog_set_preview"],
  "1  provider backends": [], // backends are orchestrator-side, not stdio tools
  "2  concept images": ["fetch_concept_image", "apply_reference_to_workflow"],
  "3  AI Toolkit": ["toolkit_status", "toolkit_run_job", "toolkit_list_models"],
  "4  RunComfy": ["runcomfy_list_pods", "runcomfy_sync_workflow", "runcomfy_queue"],
  "5  pipeline": ["run_workflow_pipeline"],
};

console.log(`\nConnected: ${tools.length} tools registered against ${COMFYUI_URL}\n`);
console.log("── Tool presence by phase ──");
let missing = [];
for (const [phase, expected] of Object.entries(PHASES)) {
  if (expected.length === 0) { console.log(`  ${phase}: (orchestrator-side, n/a to stdio)`); continue; }
  const have = expected.filter((n) => names.has(n));
  const miss = expected.filter((n) => !names.has(n));
  missing.push(...miss);
  const mark = miss.length === 0 ? "✅" : "⚠️ ";
  console.log(`  ${mark} ${phase}: ${have.length}/${expected.length}${miss.length ? "  MISSING: " + miss.join(", ") : ""}`);
}

// Safe read-only calls
async function call(name, args = {}) {
  try {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(r);
    return { ok: !r.isError, text };
  } catch (e) {
    return { ok: false, text: String(e?.message ?? e) };
  }
}

console.log("\n── Read-only tool calls ──");
const probes = [
  ["lora_catalog_list", {}],
  ["toolkit_status", {}],
  ["runcomfy_list_pods", {}],
];
for (const [name, args] of probes) {
  if (!names.has(name)) { console.log(`  MISSING ${name}`); continue; }
  const { ok, text } = await call(name, args);
  const tag = ok ? "PASS   " : "CLEAN-FAIL";
  console.log(`  ${tag} ${name}: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
}

await mcp.close();
console.log(`\n${missing.length === 0 ? "✅ all phase tools registered" : "⚠️  " + missing.length + " tool(s) missing"}`);
