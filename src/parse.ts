// Copyright 2026 the frontier-local-mcp authors.
// SPDX-License-Identifier: Apache-2.0

export const PARSER_VERSION = "1.0.0";

export const EVENT_KINDS = [
  "jump",
  "mining",
  "combat",
  "cargo_full",
  "self_destruct",
  "link_lost",
  "low_charge",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type JumpEvent = {
  kind: "jump";
  at: number;
  system: string;
};

export type MiningEvent = {
  kind: "mining";
  at: number;
  units: number;
  ore: string;
};

export type CombatEvent = {
  kind: "combat";
  at: number;
  direction: "from" | "to" | "miss";
  damage?: number;
};

export type CargoFullEvent = {
  kind: "cargo_full";
  at: number;
};

export type SelfDestructEvent = {
  kind: "self_destruct";
  at: number;
  seconds: number;
};

export type LinkLostEvent = {
  kind: "link_lost";
  at: number;
};

export type LowChargeEvent = {
  kind: "low_charge";
  at: number;
  required: number;
  available: number;
};

export type FrontierEvent =
  | JumpEvent
  | MiningEvent
  | CombatEvent
  | CargoFullEvent
  | SelfDestructEvent
  | LinkLostEvent
  | LowChargeEvent;

const STAMP = /^\[ (\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2}) \]/;
const GAME_LINE = /^\[ [\d. :]+ \] \((\w+)\) (.*)$/;
// Anchored to the timestamp. Optional `EVE System >` sender is unverified.
// Any other `Name >` sender is treated as player chat and ignored.
const LOCAL_CHANNEL =
  /^\[ [\d. :]+ \] (?:EVE System > )?Channel changed to Local : ([^>\n]+)$/;
const MINING = /^You mined (\d+) units of (.+)$/;
const COMBAT_HIT = /^(\d+)\s+(from|to)\b/;
const COMBAT_MISS = /misses you completely/;
const CARGO_FULL = /cargo bay is overloaded|cargo units would be required/;
const SELF_DESTRUCT = /self-destruct in (\d+) second/;
const LINK_LOST = /Network communication .* interrupted/;
const LOW_CHARGE = /Warping requires ([\d.]+) units of charge.*only ([\d.]+)/;

export function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

export function normalizeLogText(input: string): string {
  return input.replace(/\uFEFF/g, "").replace(/\r/g, "");
}

export function parseTimestamp(line: string): number | null {
  const match = STAMP.exec(line);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

export function parseLocalLine(raw: string): JumpEvent | null {
  const line = normalizeLogText(raw);
  const match = LOCAL_CHANNEL.exec(line);
  if (!match) return null;
  const at = parseTimestamp(line);
  if (at === null) return null;
  const system = match[1].trim();
  if (!system) return null;
  return { kind: "jump", at, system };
}

export function parseGameLine(raw: string): FrontierEvent | null {
  const line = normalizeLogText(raw);
  const match = GAME_LINE.exec(line);
  if (!match) return null;
  const at = parseTimestamp(line);
  if (at === null) return null;
  const channel = match[1];
  const message = stripTags(match[2]).trim();

  const mined = MINING.exec(message);
  if (mined) {
    if (channel !== "mining") return null;
    return {
      kind: "mining",
      at,
      units: Number(mined[1]),
      ore: mined[2].trim(),
    };
  }

  const hit = COMBAT_HIT.exec(message);
  if (hit) {
    if (channel !== "combat") return null;
    const direction = hit[2] as "from" | "to";
    return {
      kind: "combat",
      at,
      direction,
      damage: Number(hit[1]),
    };
  }

  if (COMBAT_MISS.test(message)) {
    if (channel !== "combat") return null;
    return { kind: "combat", at, direction: "miss" };
  }

  if (CARGO_FULL.test(message)) {
    return { kind: "cargo_full", at };
  }

  const selfDestruct = SELF_DESTRUCT.exec(message);
  if (selfDestruct) {
    return {
      kind: "self_destruct",
      at,
      seconds: Number(selfDestruct[1]),
    };
  }

  if (LINK_LOST.test(message)) {
    return { kind: "link_lost", at };
  }

  const charge = LOW_CHARGE.exec(message);
  if (charge) {
    return {
      kind: "low_charge",
      at,
      required: Number(charge[1]),
      available: Number(charge[2]),
    };
  }

  return null;
}
