// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVENT_KINDS,
  PARSER_VERSION,
  parseGameLine,
  parseLocalLine,
  type CombatEvent,
  type EventKind,
  type FrontierEvent,
} from "./parse.js";

export type LogsDirResolution = {
  logsDir: string;
  source: "flag" | "default";
  platform: NodeJS.Platform;
  pathVerified: boolean;
};

export type LocationSnapshot = {
  system: string | null;
  since: string | null;
  jumpsThisSession: number;
  source: "Local log";
  stale: boolean;
};

export type SessionSummary = {
  mining: Record<string, number>;
  lastCombat: CombatEvent | null;
  lastAlerts: {
    cargo_full: FrontierEvent | null;
    self_destruct: FrontierEvent | null;
    link_lost: FrontierEvent | null;
    low_charge: FrontierEvent | null;
  };
};

export type StatusSnapshot = {
  logsDir: string;
  found: boolean;
  filesTailed: string[];
  lastLineAt: string | null;
  parserVersion: string;
  platform: NodeJS.Platform;
  pathVerified: boolean;
};

type Encoding = "utf-8" | "utf-16le";

type FileState = {
  relPath: string;
  encoding: Encoding;
  offset: number;
  rest: string;
};

type FolderSpec = {
  folder: "Chatlogs" | "Gamelogs";
  encoding: Encoding;
  match: (name: string) => boolean;
};

const FOLDERS: FolderSpec[] = [
  {
    folder: "Chatlogs",
    encoding: "utf-16le",
    match: (name) => name.startsWith("Local_"),
  },
  {
    folder: "Gamelogs",
    encoding: "utf-8",
    match: (name) => /^\d/.test(name),
  },
];

const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_EVENTS = 2000;
const NEWEST_PER_FOLDER = 3;

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

export function parseLogsDirFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--logs-dir") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) return value;
    }
    if (arg.startsWith("--logs-dir=")) {
      return arg.slice("--logs-dir=".length);
    }
  }
  return undefined;
}

export function resolveLogsDir(
  input: {
    argv?: readonly string[];
    platform?: NodeJS.Platform;
    homedir?: string;
  } = {},
): LogsDirResolution {
  const platform = input.platform ?? process.platform;
  const homedir = input.homedir ?? os.homedir();
  const p = pathFor(platform);
  const flagged = parseLogsDirFlag(input.argv ?? []);
  if (flagged) {
    const logsDir = p.isAbsolute(flagged) ? p.normalize(flagged) : p.resolve(flagged);
    return { logsDir, source: "flag", platform, pathVerified: true };
  }
  return {
    logsDir: p.join(homedir, "Documents", "Frontier", "logs"),
    source: "default",
    platform,
    pathVerified: platform === "win32",
  };
}

function newestNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const da = a.replace(/^\D+/, "");
    const db = b.replace(/^\D+/, "");
    if (da !== db) return da < db ? 1 : -1;
    return b.localeCompare(a);
  });
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class FrontierLogTailer {
  readonly logsDir: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly platform: NodeJS.Platform;
  readonly pathVerified: boolean;
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  private readonly events: FrontierEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private booted = false;
  private found = false;
  private system: string | null = null;
  private sinceMs: number | null = null;
  private jumpsThisSession = 0;
  private lastSeenWallMs: number | null = null;
  private lastLineAtMs: number | null = null;
  private filesTailed: string[] = [];

  constructor(options: {
    logsDir: string;
    pollMs?: number;
    staleMs?: number;
    platform?: NodeJS.Platform;
    pathVerified?: boolean;
    now?: () => number;
  }) {
    this.logsDir = options.logsDir;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.platform = options.platform ?? process.platform;
    this.pathVerified = options.pathVerified ?? this.platform === "win32";
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.poll();
    this.booted = true;
    if (this.lastSeenWallMs === null) this.lastSeenWallMs = this.now();
    this.timer = setInterval(() => {
      void this.pollSafe();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLocation(): LocationSnapshot {
    const stale =
      this.system === null ||
      this.lastSeenWallMs === null ||
      this.now() - this.lastSeenWallMs > this.staleMs;
    return {
      system: this.system,
      since: toIso(this.sinceMs),
      jumpsThisSession: this.jumpsThisSession,
      source: "Local log",
      stale,
    };
  }

  getRecentEvents(options: {
    kinds?: EventKind[];
    sinceMs?: number;
    limit?: number;
  } = {}): FrontierEvent[] {
    const kinds = options.kinds;
    const sinceMs = options.sinceMs;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const filtered = this.events.filter((event) => {
      if (kinds && kinds.length > 0 && !kinds.includes(event.kind)) return false;
      if (sinceMs !== undefined && event.at < sinceMs) return false;
      return true;
    });
    return filtered.slice(-limit);
  }

  async waitForEvent(options: {
    kinds: EventKind[];
    timeoutMs: number;
  }): Promise<FrontierEvent | null> {
    const kinds = options.kinds.filter((kind) => (EVENT_KINDS as readonly string[]).includes(kind));
    const timeoutMs = Math.min(Math.max(options.timeoutMs, 0), 120_000);
    const startIndex = this.events.length;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const found = this.events.slice(startIndex).find((event) => kinds.includes(event.kind));
      if (found) return found;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollMs, remaining)));
    }
    return this.events.slice(startIndex).find((event) => kinds.includes(event.kind)) ?? null;
  }

  getSessionSummary(): SessionSummary {
    const mining: Record<string, number> = {};
    let lastCombat: CombatEvent | null = null;
    const lastAlerts: SessionSummary["lastAlerts"] = {
      cargo_full: null,
      self_destruct: null,
      link_lost: null,
      low_charge: null,
    };
    for (const event of this.events) {
      if (event.kind === "mining") {
        mining[event.ore] = (mining[event.ore] ?? 0) + event.units;
      } else if (event.kind === "combat") {
        lastCombat = event;
      } else if (event.kind in lastAlerts) {
        lastAlerts[event.kind as keyof typeof lastAlerts] = event;
      }
    }
    return { mining, lastCombat, lastAlerts };
  }

  getStatus(): StatusSnapshot {
    return {
      logsDir: this.logsDir,
      found: this.found,
      filesTailed: [...this.filesTailed],
      lastLineAt: toIso(this.lastLineAtMs),
      parserVersion: PARSER_VERSION,
      platform: this.platform,
      pathVerified: this.pathVerified,
    };
  }

  private async pollSafe(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<void> {
    const tailed: string[] = [];
    let sawFolder = false;
    for (const spec of FOLDERS) {
      const names = await this.listNewest(spec);
      if (names !== null) sawFolder = true;
      for (const [index, name] of (names ?? []).entries()) {
        const relPath = `${spec.folder}/${name}`;
        tailed.push(relPath);
        await this.followFile(spec, name, relPath, index === 0);
      }
    }
    this.found = sawFolder;
    this.filesTailed = tailed;
    for (const key of [...this.files.keys()]) {
      if (!tailed.includes(key)) this.files.delete(key);
    }
  }

  private async listNewest(spec: FolderSpec): Promise<string[] | null> {
    const dir = path.join(this.logsDir, spec.folder);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isFile() && spec.match(entry.name))
        .map((entry) => entry.name);
      return newestNames(names).slice(0, NEWEST_PER_FOLDER);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }

  private async followFile(
    spec: FolderSpec,
    name: string,
    relPath: string,
    newestInFolder: boolean,
  ): Promise<void> {
    const absPath = path.join(this.logsDir, spec.folder, name);
    let state = this.files.get(relPath);
    if (!state) {
      let offset = 0;
      // At startup, only the newest Local log is replayed to recover the current
      // system. Older Local files are followed from EOF so they cannot overwrite it.
      if (!this.booted && spec.folder === "Chatlogs" && !newestInFolder) {
        try {
          const size = (await fs.stat(absPath)).size;
          offset = spec.encoding === "utf-16le" ? size - (size % 2) : size;
        } catch {
          return;
        }
      }
      state = { relPath, encoding: spec.encoding, offset, rest: "" };
      this.files.set(relPath, state);
    }
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      this.files.delete(relPath);
      return;
    }
    if (stat.size < state.offset) {
      state.offset = 0;
      state.rest = "";
    }
    let end = stat.size;
    if (spec.encoding === "utf-16le") {
      const available = stat.size - state.offset;
      const even = available - (available % 2);
      if (even <= 0) return;
      end = state.offset + even;
    }
    if (end <= state.offset) return;

    const length = end - state.offset;
    const buf = Buffer.alloc(length);
    const handle = await fs.open(absPath, "r");
    try {
      const { bytesRead } = await handle.read(buf, 0, length, state.offset);
      state.offset += bytesRead;
      const decoded = new TextDecoder(spec.encoding).decode(buf.subarray(0, bytesRead));
      const combined = state.rest + decoded;
      const pieces = combined.split("\n");
      state.rest = pieces.pop() ?? "";
      for (const piece of pieces) {
        this.ingest(piece, spec.folder);
      }
    } finally {
      await handle.close();
    }
  }

  private ingest(raw: string, folder: FolderSpec["folder"]): void {
    this.lastSeenWallMs = this.now();
    const event =
      folder === "Chatlogs" ? parseLocalLine(raw) : parseGameLine(raw);
    if (!event) return;
    this.lastLineAtMs = event.at;
    if (event.kind === "jump") {
      if (this.booted && event.system !== this.system) this.jumpsThisSession += 1;
      this.system = event.system;
      this.sinceMs = event.at;
    }
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }
}
