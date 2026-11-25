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

  it("recovers location from a live Keeper Local line with a pipe system name", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261117061705.txt"),
      utf16leWithBom(
        "[ 2026.11.17 06:17:05 ] Keeper > Channel changed to Local : GES|V11\n",
      ),
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    const location = tailer.getLocation();
    assert.equal(location.system, "GES|V11");
    assert.equal(location.jumpsThisSession, 0);
    assert.equal(location.source, "Local log");
  });

  it("does not treat a spoofed Local chat body as a jump", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom(
        [
          "[ 2026.11.21 19:11:56 ] Channel changed to Local : REAL.SYS",
          "[ 2026.11.21 19:12:00 ] SomePlayer > LOL Channel changed to Local : SPOOFED",
          "",
        ].join("\n"),
      ),
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "REAL.SYS");
    const snapshot = {
      location: tailer.getLocation(),
      events: tailer.getRecentEvents(),
    };
    assert.equal(snapshot.location.system, "REAL.SYS");
    assert.equal(snapshot.location.jumpsThisSession, 0);
    assert.equal(JSON.stringify(snapshot).includes("SPOOFED"), false);
    assert.equal(JSON.stringify(snapshot).includes("SomePlayer"), false);
  });

  it(
    "wait_for_event still returns a new event after the ring buffer is full",
    { timeout: 20_000 },
    async () => {
      const tree = await makeLogsTree();
      const file = path.join(tree.game, "20261121190000.txt");
      await fs.writeFile(file, "");
      const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
      tailers.push(tailer);
      await tailer.start();

      const filler = Array.from(
        { length: 2100 },
        (_, i) =>
          `[ 2026.11.21 19:11:56 ] (mining) You mined 1 units of FillOre${i}\n`,
      ).join("");
      await fs.appendFile(file, filler);
      await waitUntil(() => tailer.getSessionSummary().mining.FillOre2099 === 1, 15_000);

      const waitPromise = tailer.waitForEvent({ kinds: ["mining"], timeoutMs: 4000 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await fs.appendFile(
        file,
        "[ 2026.11.21 19:13:00 ] (mining) You mined 4 units of UniqueWaitOre\n",
      );
      const event = await waitPromise;
      assert.ok(event);
      assert.equal(event.kind, "mining");
      assert.equal(event.kind === "mining" ? event.ore : null, "UniqueWaitOre");
    },
  );

  it("does not replay existing Gamelogs at startup", async () => {
    const tree = await makeLogsTree();
    await fs.writeFile(
      path.join(tree.chat, "Local_20261121190000.txt"),
      utf16leWithBom("[ 2026.11.21 19:11:56 ] Channel changed to Local : CUR.SYS\n"),
    );
    const gameFile = path.join(tree.game, "20261121190000.txt");
    await fs.writeFile(
      gameFile,
      "[ 2026.11.21 18:00:00 ] (mining) You mined 2201000 units of HistoryOre\n",
    );
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();
    await waitUntil(() => tailer.getLocation().system === "CUR.SYS");
    assert.equal(tailer.getSessionSummary().mining.HistoryOre, undefined);
    assert.equal(tailer.getRecentEvents({ kinds: ["mining"] }).length, 0);

    await fs.appendFile(
      gameFile,
      "[ 2026.11.21 19:13:00 ] (mining) You mined 3 units of FreshOre\n",
    );
    await waitUntil(() => tailer.getSessionSummary().mining.FreshOre === 3);
    assert.equal(tailer.getSessionSummary().mining.HistoryOre, undefined);
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

  it("reassembles a UTF-8 character split across polls", async () => {
    const tree = await makeLogsTree();
    const file = path.join(tree.game, "20261121190000.txt");
    await fs.writeFile(file, "");
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();

    const line = "[ 2026.11.21 19:11:56 ] (mining) You mined 1 units of CaféOre\n";
    const encoded = Buffer.from(line, "utf8");
    const splitAt = encoded.indexOf(Buffer.from("é", "utf8")) + 1;
    await fs.writeFile(file, encoded.subarray(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(tailer.getSessionSummary().mining["CaféOre"], undefined);

    await fs.appendFile(file, encoded.subarray(splitAt));
    await waitUntil(() => tailer.getSessionSummary().mining["CaféOre"] === 1);
  });

  it("rereads from the start after a truncate-then-regrow rewrite", async () => {
    const tree = await makeLogsTree();
    const file = path.join(tree.game, "20261121190000.txt");
    await fs.writeFile(file, "");
    const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
    tailers.push(tailer);
    await tailer.start();

    await fs.appendFile(
      file,
      "[ 2026.11.21 19:11:56 ] (mining) You mined 2 units of OldOre\n",
    );
    await waitUntil(() => tailer.getSessionSummary().mining.OldOre === 2);

    await fs.writeFile(
      file,
      [
        "[ 2026.11.21 19:12:00 ] (mining) You mined 5 units of NewOre",
        "[ 2026.11.21 19:12:01 ] (mining) You mined 7 units of NewOre",
        "",
      ].join("\n"),
    );
    await waitUntil(() => tailer.getSessionSummary().mining.NewOre === 12);
  });

  it(
    "drains a newest Local file larger than 64KiB before counting jumps",
    { timeout: 15_000 },
    async () => {
      const tree = await makeLogsTree();
      const pad = `[ 2026.11.21 19:05:00 ] PadPlayer > ${"x".repeat(80)}\n`;
      let body = "[ 2026.11.21 19:00:00 ] Channel changed to Local : FIRST.SYS\n";
      const tail = "[ 2026.11.21 19:11:56 ] Channel changed to Local : CUR.SYS\n";
      while (utf16leWithBom(body + tail).length < 82 * 1024) {
        body += pad;
      }
      const encoded = utf16leWithBom(body + tail);
      assert.ok(encoded.length > 64 * 1024);
      await fs.writeFile(path.join(tree.chat, "Local_20261121190000.txt"), encoded);

      const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
      tailers.push(tailer);
      await tailer.start();
      const location = tailer.getLocation();
      assert.equal(location.system, "CUR.SYS");
      assert.equal(location.jumpsThisSession, 0);
    },
  );

  it(
    "keeps session mining totals and lastCombat after more than 2000 events",
    { timeout: 20_000 },
    async () => {
      const tree = await makeLogsTree();
      const file = path.join(tree.game, "20261121190000.txt");
      await fs.writeFile(file, "");
      const tailer = new FrontierLogTailer({ logsDir: tree.root, pollMs: 40 });
      tailers.push(tailer);
      await tailer.start();

      await fs.appendFile(
        file,
        "[ 2026.11.21 19:11:00 ] (combat) 119 from NobodyInParticular\n",
      );
      await waitUntil(() => tailer.getSessionSummary().lastCombat?.damage === 119);

      const filler = Array.from(
        { length: 2101 },
        () => "[ 2026.11.21 19:11:56 ] (mining) You mined 1 units of KeepOre\n",
      ).join("");
      await fs.appendFile(file, filler);
      await waitUntil(() => tailer.getSessionSummary().mining.KeepOre === 2101, 15_000);

      const summary = tailer.getSessionSummary();
      assert.equal(summary.mining.KeepOre, 2101);
      assert.equal(summary.lastCombat?.kind, "combat");
      assert.equal(summary.lastCombat?.damage, 119);
      assert.equal(JSON.stringify(summary.lastCombat).includes("NobodyInParticular"), false);
    },
  );
});
