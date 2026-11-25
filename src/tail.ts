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
  decoder: InstanceType<typeof TextDecoder>;
  lastSize: number;
  ino: number | bigint;
  header: Buffer;
  tail: Buffer;
  dropUntilNewline: boolean;
};

type StoredEvent = {
  seq: number;
  event: FrontierEvent;
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
export const MAX_EVENTS = 2000;
const NEWEST_PER_FOLDER = 3;
const READ_CHUNK = 64 * 1024;
const MAX_REST = 64 * 1024;
const HEADER_BYTES = 64;
const TAIL_BYTES = 8;

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

function asNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function evenLength(length: number, encoding: Encoding): number {
  if (encoding !== "utf-16le") return length;
  return length - (length % 2);
}

function newDecoder(encoding: Encoding): InstanceType<typeof TextDecoder> {
  return new TextDecoder(encoding, { fatal: false });
}

async function readSlice(
  handle: fs.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

async function readHeader(handle: fs.FileHandle, size: number): Promise<Buffer> {
  return readSlice(handle, 0, Math.min(HEADER_BYTES, Math.max(0, size)));
}

export class FrontierLogTailer {
  readonly logsDir: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly platform: NodeJS.Platform;
  readonly pathVerified: boolean;
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  private readonly events: StoredEvent[] = [];
  private nextSeq = 0;
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
    const filtered = this.events
      .map((stored) => stored.event)
      .filter((event) => {
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
    const startSeq = this.nextSeq;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const found = this.events.find(
        (stored) => stored.seq >= startSeq && kinds.includes(stored.event.kind),
      );
      if (found) return found.event;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollMs, remaining)));
    }
    return (
      this.events.find((stored) => stored.seq >= startSeq && kinds.includes(stored.event.kind))
        ?.event ?? null
    );
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
    for (const { event } of this.events) {
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

  private replayFromStart(spec: FolderSpec, newestInFolder: boolean): boolean {
    return !this.booted && spec.folder === "Chatlogs" && newestInFolder;
  }

  private resetState(state: FileState, encoding: Encoding): void {
    state.offset = 0;
    state.rest = "";
    state.decoder = newDecoder(encoding);
    state.dropUntilNewline = false;
    state.lastSize = 0;
    state.header = Buffer.alloc(0);
    state.tail = Buffer.alloc(0);
  }

  private async followFile(
    spec: FolderSpec,
    name: string,
    relPath: string,
    newestInFolder: boolean,
  ): Promise<void> {
    const absPath = path.join(this.logsDir, spec.folder, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      this.files.delete(relPath);
      return;
    }

    const size = asNumber(stat.size);
    const handle = await fs.open(absPath, "r");
    try {
      let state = this.files.get(relPath);
      if (!state) {
        const startAtEof = !this.booted && !this.replayFromStart(spec, newestInFolder);
        const offset = startAtEof ? evenLength(size, spec.encoding) : 0;
        state = {
          relPath,
          encoding: spec.encoding,
          offset,
          rest: "",
          decoder: newDecoder(spec.encoding),
          lastSize: size,
          ino: stat.ino,
          header: await readHeader(handle, size),
          tail: Buffer.alloc(0),
          dropUntilNewline: false,
        };
        this.files.set(relPath, state);
      } else if (await this.fileWasReplaced(state, stat, handle)) {
        this.resetState(state, spec.encoding);
        state.ino = stat.ino;
        state.header = await readHeader(handle, size);
      }

      let end = evenLength(size, spec.encoding);
      if (end <= state.offset) {
        state.lastSize = size;
        return;
      }
      const available = evenLength(Math.min(end - state.offset, READ_CHUNK), spec.encoding);
      if (available <= 0) {
        state.lastSize = size;
        return;
      }

      const buf = Buffer.alloc(available);
      const { bytesRead } = await handle.read(buf, 0, available, state.offset);
      state.offset += bytesRead;
      let decoded = state.decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      if (state.dropUntilNewline) {
        const newline = decoded.indexOf("\n");
        if (newline < 0) {
          state.lastSize = size;
          return;
        }
        decoded = decoded.slice(newline + 1);
        state.dropUntilNewline = false;
      }
      const combined = state.rest + decoded;
      const pieces = combined.split("\n");
      state.rest = pieces.pop() ?? "";
      if (state.rest.length > MAX_REST) {
        state.rest = "";
        state.dropUntilNewline = true;
      }
      for (const piece of pieces) {
        this.ingest(piece, spec.folder);
      }
      if (state.offset === bytesRead) {
        state.header = await readHeader(handle, size);
      }
      if (state.offset >= TAIL_BYTES) {
        state.tail = await readSlice(handle, state.offset - TAIL_BYTES, TAIL_BYTES);
      }
      state.lastSize = size;
    } finally {
      await handle.close();
    }
  }

  private async fileWasReplaced(
    state: FileState,
    stat: Awaited<ReturnType<typeof fs.stat>>,
    handle: fs.FileHandle,
  ): Promise<boolean> {
    const size = asNumber(stat.size);
    if (size < state.offset) return true;
    if (size < state.lastSize) return true;
    if (String(state.ino) !== "0" && String(stat.ino) !== "0" && String(state.ino) !== String(stat.ino)) {
      return true;
    }
    if (state.offset === 0) return false;
    const header = await readHeader(handle, size);
    if (state.header.length > 0 && header.length > 0) {
      const n = Math.min(state.header.length, header.length);
      if (!state.header.subarray(0, n).equals(header.subarray(0, n))) return true;
    }
    if (state.offset >= TAIL_BYTES && state.tail.length === TAIL_BYTES) {
      const tail = await readSlice(handle, state.offset - TAIL_BYTES, TAIL_BYTES);
      if (!tail.equals(state.tail)) return true;
    }
    return false;
  }

  private ingest(raw: string, folder: FolderSpec["folder"]): void {
    this.lastSeenWallMs = this.now();
    const event = folder === "Chatlogs" ? parseLocalLine(raw) : parseGameLine(raw);
    if (!event) return;
    this.lastLineAtMs = event.at;
    if (event.kind === "jump") {
      if (this.booted && event.system !== this.system) this.jumpsThisSession += 1;
      this.system = event.system;
      this.sinceMs = event.at;
    }
    this.events.push({ seq: this.nextSeq, event });
    this.nextSeq += 1;
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }
}
