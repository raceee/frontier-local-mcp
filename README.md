# frontier-local-mcp

Read-only [MCP](https://modelcontextprotocol.io) server that tails the log files the **EVE Frontier** game client already writes on disk. It is meant to be useful to any player's AI agent. It ships as a TypeScript stdio process so clients can later run:

```bash
npx -y frontier-local-mcp
```

**Not published to npm yet.** Until it is, install from this repo (see below).

This is an unofficial fan project. EVE Frontier and related marks belong to their owners.

## Trust lines

- **Read-only.** The server only reads log files the client writes to disk. It never writes to those files.
- **No chat bodies.** Local chat is used only for the `Channel changed to Local : …` line, anchored after the timestamp. Allowed system senders are an explicit allowlist: `Keeper` (confirmed from a live client log) and, optionally, no sender or `EVE System >` (`EVE System` is still **unverified** and indistinguishable from a player with that display name). Any other `Name >` sender is ignored even if the message quotes the channel-change phrase. Message text is discarded. System names may include a pipe (`GES|V11`).
- **No combat names in v1.** Combat events return damage numbers and direction (`from` / `to` / `miss`) only. Attacker and target names are not returned.
- **System names only.** No ids, coordinates, or other location identifiers.
- **No network, no telemetry.** The process does not open sockets, call home, or send usage data.
- **No memory, input, or packets.** It does not touch game memory, inject input, or sniff network traffic.
- **Events, not gauges.** The logs record things that happened (jumps, yields, hits, alerts). They do not contain shield, fuel, speed, or cargo percentage.

## At your own risk

This tool only reads log files the game client writes to disk. No Fenris or CCP statement on third-party log readers was found. Use it at your own risk. It is an unofficial fan project and is not affiliated with, endorsed by, or supported by Fenris Creations or CCP.

## Tools

| Tool | Returns |
| --- | --- |
| `get_location` | `{ system, since, jumpsThisSession, source: "Local log", stale }` |
| `get_recent_events` | `{ events }` — optional `kinds`, `sinceMs`, `limit`. Kinds: `jump`, `mining`, `combat`, `cargo_full`, `self_destruct`, `link_lost`, `low_charge` |
| `wait_for_event` | Long-poll `{ timedOut, event }` for `kinds` until `timeoutMs` |
| `get_session_summary` | Running session totals: mining units per ore, last combat, last alert of each type (kept even after the recent-event ring rolls) |
| `get_status` | Log folder found, files tailed, last line time, parser version |

## Log files

Root (Windows, verified): `%USERPROFILE%\Documents\Frontier\logs`

macOS / Linux default: `~/Documents/Frontier/logs` (**unverified** — pass `--logs-dir` if your client uses another path).

| Folder | Files | Encoding | What we take |
| --- | --- | --- | --- |
| `Chatlogs/` | `Local_*` | UTF-16LE with BOM | Channel-change line only (`Keeper > Channel changed to Local : …`) |
| `Gamelogs/` | names starting with a digit | UTF-8 | mining, combat, cargo, self-destruct, link lost, low charge |

The server tails the newest 3 files in each folder. UTF-16 reads are trimmed to an even byte count. Reads are capped at 64KiB per poll; at startup the newest Local log is drained to EOF before jump counting begins, so recovering the current system does not count as a jump. A log line longer than 64KiB (including a completed line whose newline arrives on a later poll) is dropped and is not parsed as an event.

Override the root:

```bash
frontier-local-mcp --logs-dir "D:\custom\Frontier\logs"
```

Log line formats were learned from [ef-watch](https://github.com/Econmartin/ef-watch) (`index.html`). That project appears to have no license, so this repo does not copy it; the parser and tailer here are original.

## Install (not on npm yet)

```bash
git clone https://github.com/raceee/frontier-local-mcp.git
cd frontier-local-mcp
npm install
npm run build
```

Point your MCP client at `dist/server.js`. After a future npm publish, you can switch the command to `npx -y frontier-local-mcp`.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS, path unverified):

```json
{
  "mcpServers": {
    "frontier-local": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\frontier-local-mcp\\dist\\server.js"]
    }
  }
}
```

Once published:

```json
{
  "mcpServers": {
    "frontier-local": {
      "command": "npx",
      "args": ["-y", "frontier-local-mcp"]
    }
  }
}
```

Optional: add `"--logs-dir", "C:\\Users\\You\\Documents\\Frontier\\logs"` to `args`.

### Claude Code

```bash
claude mcp add frontier-local -- node C:\absolute\path\to\frontier-local-mcp\dist\server.js
```

Once published:

```bash
claude mcp add frontier-local -- npx -y frontier-local-mcp
```

### Cursor

Project `.cursor/mcp.json` or a user MCP config:

```json
{
  "mcpServers": {
    "frontier-local": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\frontier-local-mcp\\dist\\server.js"]
    }
  }
}
```

Once published, use `"command": "npx"` and `"args": ["-y", "frontier-local-mcp"]`.

### Other MCP clients

Any stdio client can spawn:

```text
node dist/server.js [--logs-dir <path>]
```

or, after publish, `npx -y frontier-local-mcp`.

## Development

```bash
npm install
npm test
npm run build
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
