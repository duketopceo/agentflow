// Canonical shared implementation moved to src/capture.mjs so the OpenCode
// plugin and the MCP server (src/mcp.mjs) share one argv/capture contract.
// This re-export keeps the plugin's import path stable.
export * from '../../src/capture.mjs';
