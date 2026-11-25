// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLogsDirFlag, resolveLogsDir } from "../src/tail.js";

describe("Windows path and --logs-dir resolution", () => {
  it("parses --logs-dir and --logs-dir=value", () => {
    assert.equal(parseLogsDirFlag(["--logs-dir", "D:\\Frontier\\logs"]), "D:\\Frontier\\logs");
    assert.equal(parseLogsDirFlag(["--logs-dir=E:\\custom"]), "E:\\custom");
    assert.equal(parseLogsDirFlag(["--help"]), undefined);
  });

  it("uses Documents/Frontier/logs on Windows and marks it verified", () => {
    const resolved = resolveLogsDir({
      argv: [],
      platform: "win32",
      homedir: "C:\\Users\\Player",
    });
    assert.equal(resolved.logsDir, "C:\\Users\\Player\\Documents\\Frontier\\logs");
    assert.equal(resolved.source, "default");
    assert.equal(resolved.pathVerified, true);
  });

  it("uses the same Documents layout on macOS and Linux but marks it unverified", () => {
    const mac = resolveLogsDir({
      argv: [],
      platform: "darwin",
      homedir: "/Users/player",
    });
    assert.equal(mac.logsDir, "/Users/player/Documents/Frontier/logs");
    assert.equal(mac.pathVerified, false);

    const linux = resolveLogsDir({
      argv: [],
      platform: "linux",
      homedir: "/home/player",
    });
    assert.equal(linux.logsDir, "/home/player/Documents/Frontier/logs");
    assert.equal(linux.pathVerified, false);
  });

  it("lets --logs-dir override the default on every platform", () => {
    const resolved = resolveLogsDir({
      argv: ["--logs-dir", "D:\\override\\logs"],
      platform: "win32",
      homedir: "C:\\Users\\Player",
    });
    assert.equal(resolved.logsDir, "D:\\override\\logs");
    assert.equal(resolved.source, "flag");
    assert.equal(resolved.pathVerified, true);
  });
});
