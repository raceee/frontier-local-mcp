// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parseGameLine, parseLocalLine } from "../src/parse.js";
import { FrontierLogTailer } from "../src/tail.js";
import {
  RECORDED_GAME,
  RECORDED_LOCAL,
  makeLogsTree,
  utf16leWithBom,
  waitUntil,
} from "./helpers.js";

const FORBIDDEN = [
  "Zx9AttackerNom",
  "FooBarPilot",
  "CORP",
  "SomePlayer",
  "LEAKME_CHAT_BODY_UNIQUE",
];

function assertNoLeak(value: unknown, label: string): void {
  const json = JSON.stringify(value);
  for (const token of FORBIDDEN) {
    assert.equal(
      json.includes(token),
      false,
      `${label} leaked ${token}: ${json}`,
    );
  }
}

describe("privacy: combat names and Local chat bodies never leak", () => {
  const tailers: FrontierLogTailer[] = [];
  after(async () => {
    await Promise.all(tailers.map((tailer) => tailer.stop()));
  });

  it("combat events expose only kind, time, damage, and direction", async () => {
    const lines = (await fs.readFile(RECORDED_GAME, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.includes("(combat)"));
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const event = parseGameLine(line);
      assert.ok(event);
      assert.equal(event.kind, "combat");
      const keys = Object.keys(event).sort();
      for (const key of keys) {
        assert.equal(
          ["at", "damage", "direction", "kind"].includes(key),
          true,
          `unexpected combat field ${key}`,
        );
      }
      assertNoLeak(event, "combat event");
    }
  });

  it("Local chat bodies are dropped; only channel-change systems remain", async () => {
    const lines = (await fs.readFile(RECORDED_LOCAL, "utf8")).split(/\r?\n/).filter(Boolean);
    const parsed = lines.map(parseLocalLine);
    assert.equal(parsed.filter(Boolean).length, 2);
    for (const event of parsed) {
      if (!event) continue;
      assert.deepEqual(Object.keys(event).sort(), ["at", "kind", "system"]);
      assertNoLeak(event, "local event");
    }
    assert.equal(JSON.stringify(parsed).includes("LEAKME_CHAT_BODY_UNIQUE"), false);
  });

  it("tailer public snapshots never include names or chat text", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121191000.txt"),
      utf16leWithBom(await fs.readFile(RECORDED_LOCAL, "utf8")),
    );
    await fs.writeFile(
      path.join(tree.game, "20261121191156.txt"),
      await fs.readFile(RECORDED_GAME),
    );

    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getRecentEvents().length > 0);

    const snapshot = {
      location: tailer.getLocation(),
      events: tailer.getRecentEvents(),
      summary: tailer.getSessionSummary(),
      status: tailer.getStatus(),
    };
    assert.equal(snapshot.location.system, "E.9QF.L15");
    assert.ok(snapshot.events.some((event) => event.kind === "combat"));
    assertNoLeak(snapshot, "tailer snapshot");
  });
});
