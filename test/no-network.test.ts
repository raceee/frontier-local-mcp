// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import dgram from "node:dgram";
import { after, before, describe, it } from "node:test";
import { FrontierLogTailer } from "../src/tail.js";
import { parseGameLine } from "../src/parse.js";
import {
  RECORDED_GAME,
  RECORDED_LOCAL,
  makeLogsTree,
  utf16leWithBom,
  waitUntil,
} from "./helpers.js";

type AnyFn = (...args: never[]) => unknown;

describe("network guard: parsing and tailing must not open sockets", () => {
  const hits: string[] = [];
  const originals: Array<{ object: object; key: string; value: unknown }> = [];

  function patch(object: object, key: string, label: string): void {
    const record = object as Record<string, unknown>;
    originals.push({ object, key, value: record[key] });
    record[key] = ((..._args: never[]) => {
      hits.push(label);
      throw new Error(`network forbidden: ${label}`);
    }) as AnyFn;
  }

  before(() => {
    patch(net.Socket.prototype, "connect", "net.Socket.connect");
    patch(net, "connect", "net.connect");
    patch(net, "createConnection", "net.createConnection");
    patch(tls, "connect", "tls.connect");
    patch(dgram.Socket.prototype, "send", "dgram.Socket.send");
    patch(dgram.Socket.prototype, "connect", "dgram.Socket.connect");
    patch(http, "request", "http.request");
    patch(https, "request", "https.request");
    patch(http, "get", "http.get");
    patch(https, "get", "https.get");
    patch(dns, "lookup", "dns.lookup");
    patch(dns.promises, "lookup", "dns.promises.lookup");
    originals.push({ object: globalThis, key: "fetch", value: globalThis.fetch });
    globalThis.fetch = (async (..._args: never[]) => {
      hits.push("fetch");
      throw new Error("network forbidden: fetch");
    }) as typeof fetch;
  });

  after(() => {
    for (const entry of originals) {
      (entry.object as Record<string, unknown>)[entry.key] = entry.value as never;
    }
  });

  it("fails this test if any socket, DNS, HTTP, or fetch call is made", async () => {
    hits.length = 0;
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121191000.txt"),
      utf16leWithBom(await fs.readFile(RECORDED_LOCAL, "utf8")),
    );
    await fs.writeFile(
      path.join(tree.game, "20261121191156.txt"),
      await fs.readFile(RECORDED_GAME),
    );

    parseGameLine((await fs.readFile(RECORDED_GAME, "utf8")).split(/\r?\n/)[0]!);

    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "E.9QF.L15");
    tailer.getRecentEvents();
    tailer.getSessionSummary();
    tailer.getStatus();
    await tailer.stop();

    assert.deepEqual(hits, []);
  });
});
