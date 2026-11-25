// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RECORDED_GAME = path.join(REPO_ROOT, "fixtures", "recorded", "game-utf8.txt");
export const RECORDED_LOCAL = path.join(
  REPO_ROOT,
  "fixtures",
  "recorded",
  "local-utf16-source.txt",
);

export function utf16leWithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

export async function makeLogsTree(): Promise<{
  root: string;
  chat: string;
  game: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontier-logs-"));
  const chat = path.join(root, "Chatlogs");
  const game = path.join(root, "Gamelogs");
  await fs.mkdir(chat);
  await fs.mkdir(game);
  return { root, chat, game };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timed out waiting for condition${lastError ? `: ${String(lastError)}` : ""}`,
  );
}
