// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  RECORDED_GAME,
  RECORDED_LOCAL,
  REPO_ROOT,
  makeLogsTree,
  utf16leWithBom,
} from "./helpers.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("MCP protocol smoke test", { timeout: 30_000 }, () => {
  let client: Client | undefined;

  after(async () => {
    await client?.close();
  });

  it("lists tools and round-trips calls over stdio with a real MCP client", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom(await fs.readFile(RECORDED_LOCAL, "utf8")),
    );
    const gameFile = path.join(tree.game, "20261121191156.txt");
    await fs.writeFile(gameFile, await fs.readFile(RECORDED_GAME));

    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.join(REPO_ROOT, "src", "server.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverPath, "--logs-dir", tree.root, "--poll-ms", "50"],
      stderr: "pipe",
    });
    client = new Client({ name: "frontier-local-mcp-smoke", version: "1.0.0" });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "get_location",
      "get_recent_events",
      "get_session_summary",
      "get_status",
      "wait_for_event",
    ]);

    const locationResult = await client.callTool({ name: "get_location", arguments: {} });
    const location = JSON.parse(textOf(locationResult));
    assert.equal(location.system, "E.9QF.L15");
    assert.equal(location.source, "Local log");
    assert.equal(location.jumpsThisSession, 0);

    const eventsResult = await client.callTool({
      name: "get_recent_events",
      arguments: { kinds: ["mining", "combat"], limit: 10 },
    });
    const events = JSON.parse(textOf(eventsResult));
    assert.equal(Array.isArray(events.events), true);
    assert.ok(events.events.some((event: { kind: string }) => event.kind === "mining"));
    assert.equal(JSON.stringify(events).includes("Zx9AttackerNom"), false);

    const statusResult = await client.callTool({ name: "get_status", arguments: {} });
    const status = JSON.parse(textOf(statusResult));
    assert.equal(status.found, true);
    assert.equal(status.logsDir, tree.root);
    assert.equal(typeof status.parserVersion, "string");

    const summaryResult = await client.callTool({
      name: "get_session_summary",
      arguments: {},
    });
    const summary = JSON.parse(textOf(summaryResult));
    assert.equal(summary.mining.Hoarfrost, 7);

    const waitPromise = client.callTool({
      name: "wait_for_event",
      arguments: { kinds: ["mining"], timeoutMs: 4000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.appendFile(
      gameFile,
      "\n[ 2026.11.21 19:13:00 ] (mining) You mined 4 units of Floe\n",
    );
    const waited = await waitPromise;
    const waitPayload = JSON.parse(textOf(waited));
    assert.equal(waitPayload.timedOut, false);
    assert.equal(waitPayload.event?.kind, "mining");
    assert.equal(waitPayload.event?.ore, "Floe");
  });
});
