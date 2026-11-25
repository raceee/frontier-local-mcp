// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it } from "node:test";
import {
  LOCAL_SYSTEM_SENDERS,
  parseGameLine,
  parseLocalLine,
  stripTags,
  type CombatEvent,
  type LowChargeEvent,
  type MiningEvent,
  type SelfDestructEvent,
} from "../src/parse.js";
import { RECORDED_GAME, RECORDED_LOCAL } from "./helpers.js";

describe("parse recorded fixture lines", () => {
  it("strips markup tags before matching mining yields", async () => {
    const tagged = (await fs.readFile(RECORDED_GAME, "utf8"))
      .split(/\r?\n/)
      .find((line) => line.includes("You mined"));
    assert.ok(tagged);
    assert.match(tagged, /<color=/);
    const stripped = stripTags(tagged);
    assert.equal(stripped.includes("<"), false);
    assert.match(stripped, /You mined 7 units of Hoarfrost/);

    const event = parseGameLine(tagged) as MiningEvent | null;
    assert.ok(event);
    assert.equal(event.kind, "mining");
    assert.equal(event.units, 7);
    assert.equal(event.ore, "Hoarfrost");
    assert.equal(event.at, Date.UTC(2026, 10, 21, 19, 11, 56));
  });

  it("parses combat hits as damage and direction only", async () => {
    const lines = (await fs.readFile(RECORDED_GAME, "utf8")).split(/\r?\n/);
    const incoming = parseGameLine(lines[1]!) as CombatEvent | null;
    const outgoing = parseGameLine(lines[2]!) as CombatEvent | null;
    assert.deepEqual(
      { kind: incoming?.kind, damage: incoming?.damage, direction: incoming?.direction },
      { kind: "combat", damage: 119, direction: "from" },
    );
    assert.deepEqual(
      { kind: outgoing?.kind, damage: outgoing?.damage, direction: outgoing?.direction },
      { kind: "combat", damage: 42, direction: "to" },
    );
  });

  it("parses a complete miss without a damage number", async () => {
    const lines = (await fs.readFile(RECORDED_GAME, "utf8")).split(/\r?\n/);
    const miss = parseGameLine(lines[3]!) as CombatEvent | null;
    assert.equal(miss?.kind, "combat");
    assert.equal(miss?.direction, "miss");
    assert.equal(miss?.damage, undefined);
  });

  it("parses cargo-full, self-destruct, link-lost, and low-charge alerts", async () => {
    const lines = (await fs.readFile(RECORDED_GAME, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    const kinds = lines.map((line) => parseGameLine(line)?.kind);
    assert.equal(kinds.includes("cargo_full"), true);
    assert.equal(kinds.filter((kind) => kind === "cargo_full").length, 2);

    const sd = lines.map(parseGameLine).find((event) => event?.kind === "self_destruct") as
      | SelfDestructEvent
      | undefined;
    assert.equal(sd?.seconds, 30);

    assert.equal(
      lines.map(parseGameLine).some((event) => event?.kind === "link_lost"),
      true,
    );

    const charge = lines.map(parseGameLine).find((event) => event?.kind === "low_charge") as
      | LowChargeEvent
      | undefined;
    assert.equal(charge?.required, 50);
    assert.equal(charge?.available, 12.5);
  });

  it("extracts only Local channel-change systems from recorded chat logs", async () => {
    const lines = (await fs.readFile(RECORDED_LOCAL, "utf8")).split(/\r?\n/).filter(Boolean);
    const parsed = lines.map(parseLocalLine);
    assert.equal(parsed[0]?.kind, "jump");
    assert.equal(parsed[0]?.system, "K.4RD.T72");
    assert.equal(parsed[1]?.system, "E.9QF.L15");
    assert.equal(parsed[2], null);
  });

  it("rejects a player chat line that spoofs a Local channel change", () => {
    const spoofed =
      "[ 2026.11.21 19:12:00 ] SomePlayer > LOL Channel changed to Local : SPOOFED";
    const event = parseLocalLine(spoofed);
    assert.equal(event, null);
    assert.equal(JSON.stringify(event), "null");

    assert.equal(
      parseLocalLine(
        "[ 2026.11.21 19:12:00 ] SomePlayer > Channel changed to Local : SPOOFED",
      ),
      null,
    );

    const prefixUnverified =
      "[ 2026.11.21 19:11:56 ] EVE System > Channel changed to Local : K.4RD.T72";
    const prefixed = parseLocalLine(prefixUnverified);
    assert.equal(prefixed?.kind, "jump");
    assert.equal(prefixed?.system, "K.4RD.T72");
  });

  it("accepts the live Keeper system sender and pipe-form system names", async () => {
    assert.deepEqual([...LOCAL_SYSTEM_SENDERS], ["Keeper", "EVE System"]);
    const live = (
      await fs.readFile(
        new URL("../fixtures/recorded/local-keeper.txt", import.meta.url),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .find((line) => line.includes("Channel changed"));
    assert.equal(
      live,
      "[ 2026.11.17 06:17:05 ] Keeper > Channel changed to Local : GES|V11",
    );
    const event = parseLocalLine(live!);
    assert.equal(event?.kind, "jump");
    assert.equal(event?.system, "GES|V11");
    assert.equal(event?.at, Date.UTC(2026, 10, 17, 6, 17, 5));

    assert.equal(
      parseLocalLine(
        "[ 2026.11.17 06:18:00 ] Keeper > Channel changed to Local : G48|L11",
      )?.system,
      "G48|L11",
    );
    assert.equal(
      parseLocalLine(
        "[ 2026.11.17 06:19:00 ] Keeper > Channel changed to Local : DI7|021",
      )?.system,
      "DI7|021",
    );
  });

  it("requires (mining) and (combat) channel tags", () => {
    assert.equal(
      parseGameLine("[ 2026.11.21 19:11:56 ] (notify) 5 from the station manager"),
      null,
    );
    assert.equal(
      parseGameLine("[ 2026.11.21 19:11:56 ] (notify) You mined 999 units of FakeOre"),
      null,
    );
    assert.equal(
      parseGameLine("[ 2026.11.21 19:11:56 ] (mining) You mined 7 units of Hoarfrost")?.kind,
      "mining",
    );
    assert.equal(
      parseGameLine("[ 2026.11.21 19:11:56 ] (combat) 119 from NobodyInParticular")?.kind,
      "combat",
    );
  });

  it("ignores game-log lines that do not match a known event", () => {
    assert.equal(
      parseGameLine("[ 2026.11.21 19:11:56 ] (info) Some unrelated client notice"),
      null,
    );
    assert.equal(parseGameLine("not a log line at all"), null);
  });
});
