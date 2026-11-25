#!/usr/bin/env node
// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EVENT_KINDS, PARSER_VERSION, type EventKind } from "./parse.js";
import {
  FrontierLogTailer,
  parseLogsDirFlag,
  resolveLogsDir,
} from "./tail.js";

const KIND_ENUM = z.enum(EVENT_KINDS);
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const HELP = `frontier-local-mcp ${PARSER_VERSION}
Read-only stdio MCP server. Tails EVE Frontier client log files; makes no network calls.

Usage:
  frontier-local-mcp [--logs-dir <path>] [--poll-ms <n>]

  --logs-dir   Override the log root (default: Documents/Frontier/logs)
  --poll-ms    Poll interval in milliseconds (default: 250)
  -h, --help   Show this help on stderr

Windows default (verified): %USERPROFILE%\\Documents\\Frontier\\logs
macOS/Linux default: ~/Documents/Frontier/logs (unverified)
`;

export function parsePollMsFlag(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--poll-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    if (arg.startsWith("--poll-ms=")) {
      const value = Number(arg.slice("--poll-ms=".length));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function createServer(tailer: FrontierLogTailer): McpServer {
  const server = new McpServer(
    { name: "frontier-local-mcp", version: PARSER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "get_location",
    {
      description:
        "Current star system from the Local chat channel-change line. Returns system name, time entered, jumps this session, source, and a stale flag. No ids or coordinates.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(tailer.getLocation()),
  );

  server.registerTool(
    "get_recent_events",
    {
      description:
        "Recent parsed log events (jump, mining, combat, cargo_full, self_destruct, link_lost, low_charge). Combat includes damage and direction only — never names. Chat bodies are never returned.",
      inputSchema: {
        kinds: z.array(KIND_ENUM).optional(),
        sinceMs: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ kinds, sinceMs, limit }) =>
      jsonResult({
        events: tailer.getRecentEvents({
          kinds: kinds as EventKind[] | undefined,
          sinceMs,
          limit,
        }),
      }),
  );

  server.registerTool(
    "wait_for_event",
    {
      description:
        "Long-poll until the next matching event is parsed from the local logs, or until timeoutMs elapses.",
      inputSchema: {
        kinds: z.array(KIND_ENUM).min(1),
        timeoutMs: z.number().int().nonnegative().max(120_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ kinds, timeoutMs }) => {
      const event = await tailer.waitForEvent({
        kinds: kinds as EventKind[],
        timeoutMs: timeoutMs ?? 30_000,
      });
      return jsonResult({ timedOut: event === null, event });
    },
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Session totals: mining units per ore, last combat event (damage/direction only), and the last alert of each type.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(tailer.getSessionSummary()),
  );

  server.registerTool(
    "get_status",
    {
      description:
        "Log folder found, files currently tailed, last parsed line time, and parser version. Makes no network calls.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(tailer.getStatus()),
  );

  return server;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(HELP);
    return;
  }

  const resolved = resolveLogsDir({ argv });
  const tailer = new FrontierLogTailer({
    logsDir: resolved.logsDir,
    pollMs: parsePollMsFlag(argv),
    platform: resolved.platform,
    pathVerified: resolved.pathVerified,
  });
  await tailer.start();

  const server = createServer(tailer);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const flag = parseLogsDirFlag(argv);
  console.error(
    `frontier-local-mcp ${PARSER_VERSION}: tailing ${resolved.logsDir}` +
      (flag ? " (--logs-dir)" : resolved.pathVerified ? "" : " (path unverified on this OS)"),
  );
}

function startedFromCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  return path.resolve(entry).toLowerCase() === self.toLowerCase();
}

if (startedFromCli()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
