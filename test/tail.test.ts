// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { FrontierLogTailer } from "../src/tail.js";
import { makeLogsTree, utf16leWithBom, waitUntil } from "./helpers.js";

describe("log tailer", () => {
  const tailers: FrontierLogTailer[] = [];
  after(async () => {
    await Promise.all(tailers.map((tailer) => tailer.stop()));
  });

  it("holds partial lines until a newline arrives", async () => {
    const tree = await makeLogsTree();
    const file = path.join(tree.game, "20261121190000.txt");
    await fs.writeFile(file, "");
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();

    await fs.writeFile(
      file,
      "[ 2026.11.21 19:11:56 ] (mining) You mined 3 units of Hoarfrost",
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(tailer.getRecentEvents().length, 0);

    await fs.appendFile(file, "\n");
    await waitUntil(() => tailer.getRecentEvents().some((event) => event.kind === "mining"));
    const mining = tailer.getRecentEvents({ kinds: ["mining"] })[0];
    assert.equal(mining && "units" in mining ? mining.units : null, 3);
  });

  it("keeps an odd leftover UTF-16 byte until the pair is complete", async () => {
    const tree = await makeLogsTree();
    const file = path.join(tree.chat, "Local_20261121190000.txt");
    const line = "[ 2026.11.21 19:11:56 ] Channel changed to Local : ODD.SYS.1\n";
    const encoded = utf16leWithBom(line);
    await fs.writeFile(file, encoded.subarray(0, encoded.length - 1));

    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(tailer.getLocation().system, null);

    await fs.writeFile(file, encoded);
    await waitUntil(() => tailer.getLocation().system === "ODD.SYS.1");
  });

  it("strips a UTF-16LE BOM and still reads the channel-change line", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom("[ 2026.11.21 19:11:56 ] Channel changed to Local : BOM.SYS.A\n"),
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "BOM.SYS.A");
    assert.equal(tailer.getLocation().source, "Local log");
  });

  it("rotates onto a newer Local file", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom("[ 2026.11.21 19:00:00 ] Channel changed to Local : OLD.SYS.1\n"),
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "OLD.SYS.1");

    await fs.writeFile(
      path.join(tree.chat, "Local_20261121199999.txt"),
      utf16leWithBom("[ 2026.11.21 19:30:00 ] Channel changed to Local : NEW.SYS.9\n"),
    );
    await waitUntil(() => tailer.getLocation().system === "NEW.SYS.9");
    assert.equal(tailer.getLocation().jumpsThisSession, 1);
  });

  it("recovers the current system from the newest Local log at startup without counting a jump", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121000000.txt"),
      utf16leWithBom("[ 2026.11.21 18:00:00 ] Channel changed to Local : FIRST.SYS\n"),
    );
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom(
        [
          "[ 2026.11.21 19:00:00 ] Channel changed to Local : MID.SYS",
          "[ 2026.11.21 19:11:56 ] Channel changed to Local : CUR.SYS",
          "",
        ].join("\n"),
      ),
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "CUR.SYS");
    const location = tailer.getLocation();
    assert.equal(location.jumpsThisSession, 0);
    assert.equal(location.source, "Local log");
    assert.equal(location.since, "2026-11-21T19:11:56.000Z");
  });
});
