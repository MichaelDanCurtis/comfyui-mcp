#!/usr/bin/env node
/**
 * Quick local MCP smoke: connect to linked dist/index.js and call health_check + photomap_health.
 * Usage: npm run build && node scripts/test-mcp-local.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:9500";
const COMFYUI_PATH = process.env.COMFYUI_PATH ?? "/Users/michaelcurtis/Documents/ComfyUI";

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

const mcp = new Client({ name: "mcp-local-smoke", version: "0.0.0" });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
const photomap = tools.filter((t) => t.name.startsWith("photomap_"));
console.log(`Tools: ${tools.length} total, ${photomap.length} photomap_*`);

for (const name of ["health_check", "photomap_health", "get_system_stats"]) {
  if (!tools.some((t) => t.name === name)) {
    console.log(`SKIP ${name} (not registered)`);
    continue;
  }
  const result = await mcp.callTool({ name, arguments: {} });
  const text = result.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
  console.log(`\n=== ${name} ===\n${text.slice(0, 800)}`);
}

await mcp.close();
console.log("\n✅ local MCP smoke passed");