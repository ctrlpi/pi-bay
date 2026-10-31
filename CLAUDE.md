# CLAUDE.md - pi-bay

This file provides guidance to Claude Code when working in this repository.

## The README is locked

`README.md` is done. Do not edit it without the user's explicit confirmation, even for a small wording or formatting fix, and even to keep it in sync with another project's README.

## What this is

`pi-bay` is an app and MCP server for finding Raspberry Pis and other SSH devices on a LAN, browsing their files, running remote commands, and opening an SSH terminal.

The app uses Node.js with built-in modules along with `ssh2` and `ws` for remote device communication, and `@xterm/xterm` for interactive terminal sessions in the browser. The backend, network scanner, SSH/SFTP handlers, HTTP API, and MCP server live in [server.js](server.js). Common utilities, path safety, and ZIP packaging live in [lib.js](lib.js). The frontend is [page.html](page.html).

The npm package is **`@ctrlpi/pi-bay`**. Its executable is `server.js`, and the package includes `server.js`, `lib.js`, `page.html`, `favicon.ico` (the ctrlPi icon, served at `/favicon.ico`), `README.md`, `test`, and `LICENSE`.

## Location

This repository lives at `pi-bay/` inside the ctrlpi workspace folder, next to the other ctrlpi projects. It is its own git repository (the workspace root gitignores it), and the workspace root `CLAUDE.md` rules apply here too. Releases reach the Production copy through the root `copy_to_prod.py` (checked with `chk_prod.py`). Publishing is described in the root `CLAUDE.md` only. `search.py` is a standalone Python LAN scanner kept for reference; it is not part of the npm package.

## Running

```bash
npm start
npm run dev
npm test
node server.js [--port 8383] [--host 127.0.0.1] [--ssh-port 22] [--api-port 8314] [--no-open] [--no-mcp]
node server.js --mcp-stdio
node server.js --mcp-http
node server.js --help
node server.js --version
```

Configuration precedence is command line, environment, then default:

- Port: `--port`, `PORT`, `8383`.
- Host: `--host`, `PI_BAY_HOST`, then `127.0.0.1`; Raspberry Pi hosts default to `0.0.0.0`.
- Allowed host names: `--allow-host` (repeatable or comma-separated) plus `PI_BAY_ALLOW_HOSTS`. `hostAllowed()` checks the `Host` header on every route, `/mcp` and the `/terminal` WebSocket included, against DNS rebinding: IP addresses, `localhost`, `os.hostname()` (with or without `.local`), the `--host` value and these names pass, anything else gets `403`.
- SSH Port: `--ssh-port`, `22`.
- ctrlPi API Port: `--api-port`, `8314`.
- ctrlPi API Key: `--api-key`, `your-secret-key`.
- Browser launch: `--no-open` or `PI_BAY_NO_OPEN`; Raspberry Pi hosts never open a browser.
- MCP: `--mcp-stdio`/`PI_BAY_MCP_STDIO` or `--mcp-http`/`PI_BAY_MCP_HTTP`. Raspberry Pi hosts enable HTTP MCP by default; `--no-mcp`/`PI_BAY_NO_MCP` disables all MCP transports.

Boolean environment values accept `true`, `false`, `1`, or `0`.

## Architecture

The process has five main components:

1. **Discovery layer**: `localIPv4()` picks the LAN address the workspace way (a UDP socket "connected" to `8.8.8.8:80`, falling back to the first active IPv4 interface), then scans that `/24` subnet for open SSH (port 22) and ctrlPi (port 8314) ports, resolving device names through ctrlPi `/hello`, reverse DNS, Bonjour on macOS, and NetBIOS/SMB. Identifies verified Raspberry Pis by MAC OUI or hostname prefix.
2. **Authentication & Credential store**: stores non-sensitive device info in `~/.ctrlpi/pi-bay-devices.json` (mode `0600`, outside the package so npm installs keep it; `CONFIG_PATH` in `server.js`), while credentials are saved into the system keychain (macOS Keychain via `security` or Linux Secret Service via `secret-tool`). Supports automatic public key authentication via `SSH_AUTH_SOCK` (SSH agent) and standard identity files (`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`).
3. **Remote filesystem layer**: uses SFTP to browse, read, write, create, rename, and delete remote files. All file operations are strictly constrained relative to the user's remote `$HOME` directory using `safeRelative()` and `remotePath()`.
4. **Interactive terminal layer**: WebSocket endpoint (`/terminal`) connected to `xterm-256color` SSH shell sessions.
5. **Servers**: web UI and JSON API, plus zero-dependency MCP stdio and Streamable HTTP transports.

Important HTTP routes include:

- `/`: Web UI loaded from `page.html`.
- `/api/devices` and `/api/devices/stream`: Network scan results.
- `/api/connect` and `/api/disconnect`: SSH session establishment and teardown.
- `/api/files`, `/api/file`, `/api/mkdir`, `/api/touch`, and `/api/rename`: Remote filesystem management. `PUT`/`POST /api/file` streams the request body straight to SFTP (no size cap) and creates missing parent folders.
- `/api/zip`: Remote folder download as ZIP archive.
- `/api/restore`: `POST` a ZIP (Store or Deflate, up to 64 MiB, 4096 files, 256 MiB decompressed) to extract it into `$HOME` (or `?path=`). Parsing and path checks live in `parseZipBuffer()` in `lib.js`.
- `/api/reboot`: Remote device reboot.
- `/api/readme`: Full README content.
- `/api/mcp`: Runtime toggle for HTTP MCP (`POST /api/mcp?enabled=0|1`).
- `/mcp`: Streamable HTTP MCP endpoint when enabled.

## Frontend

`page.html` holds the whole UI (no build step). File-tree rows use `data-act` buttons handled by one delegated click listener; never build inline `onclick` strings from file paths.

- **Drag and drop** on `#files`: OS files and folders (walked with `webkitGetAsEntry`) upload into the folder row they are dropped on, the dropped-on file's folder, or `$HOME`. Dragging a row onto a folder moves it through `/api/rename`; dragging a file out sets `DownloadURL` for a desktop download. `movePathTo()` is the single move/rename path and fixes up `allFiles`, `loadedDirs`, `expandedDirs`, and the open file.
- **Install ctrlPi API** opens a popup (agent name, API key, Lite/Full). It writes `~/pi-gpio-api/config.json` over SFTP when the Pi has none, so `install.sh` skips its own prompts, then types `curl ... install.sh | bash -s -- --lite|--full` into the Terminal tab through `sendToTerminal()`. The key never goes through the shell.
- **Run** sends `cd <folder> && python3|./<file>|node <file>` to the Terminal tab. **Format JSON** reformats with 3-space indentation while editing. **Restore from ZIP** posts to `/api/restore`.

## Model Context Protocol (MCP)

`pi-bay` includes a native, dependency-free MCP server supporting revision `2026-07-28` (`server/discover`, tool schemas, annotations) and legacy initialization (`2025-03-26` through `2025-11-25`).

### Transports

- **Stdio (`--mcp-stdio`)**: For Claude Desktop, Cursor, or local agents. Standard output is reserved strictly for JSON-RPC messages; informational logs are redirected to standard error.
- **HTTP (`--mcp-http`)**: Serves MCP over Streamable HTTP at `/mcp` alongside the web interface. Enabled by default on Raspberry Pi hosts.

### Tools

- `pi_devices_list`: Scan and list local Raspberry Pis and SSH devices.
- `pi_device_info`: Detailed device information (model, OS, kernel, storage, memory, uptime, ctrlPi).
- `pi_device_authenticate`: Verify SSH credentials and optionally save to the system keychain. It is the only tool that takes `username` and `password`; `getDeviceSession()` gives the others its open connection, or signs in again with the saved username and keychain password (or SSH keys).
- `pi_command_run`: Non-interactive shell execution with timeout and output capture.
- `pi_files_list`: List files and directories relative to `$HOME`.
- `pi_file_read`: Read file content (auto UTF-8 text or base64 binary).
- `pi_file_write`: Write or update files, creating missing parent directories.
- `pi_directory_create`: Create directories relative to `$HOME`.
- `pi_path_rename`: Rename or move files and folders.
- `pi_path_delete`: Delete files or directories recursively.
- `pi_device_reboot`: Send reboot signal to the remote device.
- `pi_ctrlpi_install`: "Install ctrlPi API" without the Terminal tab: writes `~/pi-gpio-api/config.json` on a first install (a missing name or key gets the installer's defaults, the hostname and `your-secret-key`, and a default key adds a `warning` to the result), runs `install.sh --lite|--full` (`CTRLPI_INSTALL_CMD`), then creates and starts, or restarts, the `pi-gpio-api` service when `sudo -n` works (`CTRLPI_SERVICE_CMD`, the installer's own unit). Needs `confirmed: true`.

### Security and Sandboxing

- Remote file paths are constrained to `$HOME` and path traversal (`..`) is rejected.
- All state-mutating HTTP API requests require same-origin access.
- Cross-origin MCP requests over HTTP are validated against origin headers.

## Testing

Run the test suite with:

```bash
npm test
```

The test suite covers:
- `test/lib.test.js`: MAC normalization, path sandboxing, CRC32, ZIP archives and ZIP restore parsing, Pi host detection, transport selection, text/binary heuristics, and content decoding.
- `test/server.test.js`: Static assets and UI hooks, README endpoints, session authentication protections (including upload and restore), and cross-origin rejections.
- `test/mcp.test.js`: Protocol discovery, legacy initialization, tool schemas, path traversal security, HTTP `/mcp` routes, origin checks, `/api/mcp` toggle, and stdio execution.
