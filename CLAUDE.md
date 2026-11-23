# CLAUDE.md - pi-bay

This file provides guidance to Claude Code when working in this repository.

## The README is locked

`README.md` is done. Do not edit it without the user's explicit confirmation, even for a small wording or formatting fix, and even to keep it in sync with another project's README.

## What this is

`pi-bay` is an app and MCP server for finding Raspberry Pis and other SSH devices on a LAN, browsing their files, running remote commands, and opening an SSH terminal.

The app uses Node.js with built-in modules along with `ssh2` and `ws` for remote device communication, and `@xterm/xterm` for interactive terminal sessions in the browser. The backend, network scanner, SSH/SFTP handlers, HTTP API, and MCP server live in [server.js](server.js). Common utilities, path safety, and ZIP packaging live in [lib.js](lib.js). The frontend is [page.html](page.html).

The npm package is **`pi-bay`**. Its executable is `server.js`, and the package includes `server.js`, `lib.js`, `page.html`, `favicon.ico` (the ctrlPi icon, served at `/favicon.ico`), `README.md`, `test`, and `LICENSE`.

## Location

This repository lives at `pi-bay/` inside the ctrlpi workspace folder, next to the other ctrlpi projects. It is its own git repository (the workspace root gitignores it), and the workspace root `CLAUDE.md` rules apply here too. Publishing is described in the root `CLAUDE.md` only.

## Running

```bash
npm start
npm run dev
npm test
node server.js [--port 3141] [--host 127.0.0.1] [--ssh-port 22] [--api-port 8314] [--no-open] [--ui on|off] [--mcp off|http|stdio]
node server.js --mcp stdio
node server.js --mcp http
node server.js --ui off
node server.js --help
node server.js --version
```

Configuration precedence is command line, environment, then default:

- Port: `--port`, `PORT`, `3141`. On a busy port (`listenOnFreePort()`) a pi-bay already running there is opened in the browser and no second copy starts. When another program holds it, the next 3 ports are tried, only for the default port on a desktop without HTTP MCP; otherwise it fails with a port-in-use message.
- Host: `--host`, `PI_BAY_HOST`, then `127.0.0.1`; Raspberry Pi hosts default to `0.0.0.0`.
- Allowed host names: `--allow-host` (repeatable or comma-separated) plus `PI_BAY_ALLOW_HOSTS`. `hostAllowed()` checks the `Host` header on every route, `/mcp` and the `/terminal` WebSocket included, against DNS rebinding: IP addresses, `localhost`, `os.hostname()` (with or without `.local`), the `--host` value and these names pass, anything else gets `403`.
- SSH Port: `--ssh-port`, `22`.
- ctrlPi API Port: `--api-port`, `8314`.
- ctrlPi API Key: `--api-key`, `your-secret-key`.
- Browser launch: `--no-open` or `PI_BAY_NO_OPEN`; Raspberry Pi hosts never open a browser.
- Mode: `--ui on|off` (`PI_BAY_UI`) and `--mcp off|http|stdio` (`PI_BAY_MCP`), parsed by `parseMode()`; a flag wins over its variable, and the old flags (`--mcp-stdio`, `--mcp-http`, `--mcp-only`, `--no-mcp`) and variables are ignored. `--ui off` alone means `--mcp http`; `--mcp stdio` means no web UI. `--ui off --mcp off`, `--ui on --mcp stdio` and a bad value exit with code 2. Raspberry Pi hosts enable HTTP MCP by default (`--mcp off` disables it). With neither `--ui` nor `--mcp` set (and no variable) and stdin a pipe or socket, `detectMcpStdio()` reads the first line: a JSON-RPC message starts stdio MCP; anything else, a closed stdin or 2 seconds of silence starts the web app. A web start logs `ui: on|off, mcp: off|http (key set: yes|no)`.

Boolean environment values accept `true`, `false`, `1`, or `0`.

## Architecture

The process has five main components:

1. **Discovery layer**: `localIPv4()` picks the LAN address the workspace way (a UDP socket "connected" to `8.8.8.8:80`, falling back to the first active IPv4 interface), then scans that `/24` subnet for open SSH (port 22) and ctrlPi (port 8314) ports. A device's `name` is its ctrlPi agent name (`/hello`) when it has one, else its `hostname`: reverse DNS, Bonjour on macOS, NetBIOS/SMB (only without an agent name), and last the one `/api/connect` reads from `/etc/hostname` and saves with the device (`decorateDevice()` fills it in). When name and hostname differ, the devices table shows `name (hostname)` and the pill popup adds a Hostname line. Identifies verified Raspberry Pis by MAC OUI or hostname prefix.
2. **Authentication & Credential store**: stores non-sensitive device info in `~/.ctrlpi/pi-bay-devices.json` (mode `0600`, outside the package so npm installs keep it; `CONFIG_PATH` in `server.js`), while credentials are saved into the system keychain (macOS Keychain via `security` or Linux Secret Service via `secret-tool`). Supports automatic public key authentication via `SSH_AUTH_SOCK` (SSH agent) and standard identity files (`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`).
3. **Remote filesystem layer**: uses SFTP to browse, read, write, create, rename, and delete remote files. All file operations are strictly constrained relative to the user's remote `$HOME` directory using `safeRelative()` and `remotePath()`.
4. **Interactive terminal layer**: WebSocket endpoint (`/terminal`) connected to `xterm-256color` SSH shell sessions.
5. **Servers**: web UI and JSON API, plus zero-dependency MCP stdio and Streamable HTTP transports.

Important HTTP routes include:

- `/`: Web UI loaded from `page.html`.
- `/api/devices` and `/api/devices/stream`: Network scan results.
- `/api/connect` and `/api/disconnect`: SSH session establishment and teardown. Connect also reads the model, RAM, disk size and hostname and saves them with the device. RAM is saved and shown as the board's nominal size (`nominalRam()`: 415MB measured is 512MB). A scan cannot read RAM or disk size: a device never signed in to shows `hardwareSpecs()`' typical RAM and clock for its model (in `lib.js` and again in `page.html`: keep the two the same) and no SD chip. `decorateDevice()` drops saved specs when another kind of board answers at the address (`modelFamily()`) or the board is a microcontroller.
- `/api/files`, `/api/file`, `/api/mkdir`, `/api/touch`, and `/api/rename`: Remote filesystem management. `PUT`/`POST /api/file` streams the request body straight to SFTP (no size cap) and creates missing parent folders.
- `/api/zip`: Remote folder download as ZIP archive.
- `/api/restore`: `POST` a ZIP (Store or Deflate, up to 64 MiB, 4096 files, 256 MiB decompressed) to extract it into `$HOME` (or `?path=`). Parsing and path checks live in `parseZipBuffer()` in `lib.js`.
- `/api/reboot`: Remote device reboot.
- `/api/readme`: Full README content.
- `/api/mcp`: Runtime toggle for HTTP MCP (`POST /api/mcp?enabled=0|1`).
- `/mcp`: Streamable HTTP MCP endpoint when enabled.
- `/hello` and `/remote-config` (always served, for `ctrlpi-remote`): see "HTTP MCP key" below.

### HTTP MCP key

`POST /mcp` needs `Api-Key`. The key is `mcp.api_key` (with `mcp.key_set`) in `~/.ctrlpi/pi-bay-config.json` (`MCP_CONFIG_PATH`; `--config <folder>` holds it and `pi-bay-devices.json`, a `.json` path is the key file with the devices file beside it, `resolveConfigFiles()`; a `--config` without a value exits with code 2), re-read on every request. The default `your-mcp-key` is accepted until the first different key (1-128 printable ASCII characters) claims it and is saved (`mcpKeyAccepted()`, trust on first use, not adopted when the file cannot be written); wrong or missing gets `403` and a `[SECURITY]` log line. `GET /hello` (no key) answers `{"service": "pi-bay", "key": <true once a key is set>}`. `POST /remote-config` with the current key and `{"api_key": "<new>"}` changes it: `200 {key_set}`, `403` (wrong key or foreign `Origin`), `400` (empty, the default, over 128 or not printable), `405`, `413` (over 4 KB), `500` (not saved); it never claims a key. Stdio MCP needs no key. Recovery: remove `mcp.api_key` from the file and the default works again. The web UI and its `/api/*` routes have no key.

`--ui off` implies HTTP MCP, never opens a browser, and serves only `/mcp`, `/hello` and `/remote-config`: everything else, the page and `/api/mcp` included, is a `404`, and `pi_ui` refuses with a tool error. With `--mcp off` it exits with code 2.

## Frontend

`page.html` holds the whole UI (no build step). File-tree rows use `data-act` buttons handled by one delegated click listener; never build inline `onclick` strings from file paths.

- **Drag and drop** on `#files`: OS files and folders (walked with `webkitGetAsEntry`) upload into the folder row they are dropped on, the dropped-on file's folder, or `$HOME`. Dragging a row onto a folder moves it through `/api/rename`; dragging a file out sets `DownloadURL` for a desktop download. `movePathTo()` is the single move/rename path and fixes up `allFiles`, `loadedDirs`, `expandedDirs`, and the open file.
- **Install ctrlPi API** opens a popup (agent name, API key, Lite/Full). It writes `~/pi-gpio-api/config.json` over SFTP when the Pi has none, so `install.sh` skips its own prompts, then types `curl ... install.sh | bash -s -- --lite|--full` into the Terminal tab through `sendToTerminal()`. The key never goes through the shell. The API key is not required: the field shows `your-secret-key` in grey, an empty field writes that default, and the popup's hint says it is public.
- **Server connection**: every request goes through `serverFetch()`, and `GET /api/mcp` every 3 s notices a stopped server while the page is idle (it answers with MCP on or off). A red banner shows and the device menu is disabled until it answers again; then a "Reconnected" toast, a scan that failed runs again, and a session the restart lost (`/api/files` answers `Not connected`) returns to the devices and the sign-in box.
- **Run** sends `cd <folder> && python3|./<file>|node <file>` to the Terminal tab. **Format JSON** reformats with 3-space indentation while editing. **Restore from ZIP** posts to `/api/restore`.

## Model Context Protocol (MCP)

`pi-bay` includes a native, dependency-free MCP server supporting revision `2026-07-28` (`server/discover`, tool schemas, annotations) and legacy initialization (`2025-03-26` through `2025-11-25`).

### Transports

- **Stdio (`--mcp stdio`, or detected on stdin)**: For Claude Desktop, Cursor, or local agents. Standard output is reserved strictly for JSON-RPC messages; informational logs are redirected to standard error.
- **HTTP (`--mcp http`)**: Serves MCP over Streamable HTTP at `/mcp` alongside the web interface. Enabled by default on Raspberry Pi hosts.

### Tools

- `pi_devices_list`: Scan and list local Raspberry Pis and SSH devices, with `name` and `hostname`.
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
- `pi_ui`: opens the web UI (`openUi()`) or, with `action: "stop"`, stops it (`stopUi()`). Under stdio MCP no web server runs, so `ensureUiServer()` starts it on the first call, on the port or one of the next 3, or uses a pi-bay already running there; it lives until the client closes stdin. The browser opens only on a local desktop. For a client elsewhere (a Raspberry Pi host, a non-loopback `Host` on HTTP MCP, `SSH_CONNECTION` under stdio) or with `--no-open`, the result is `opened: false` and the `url` to open: the request's `Host`, the ssh session's address, else the LAN address. Stop closes only a server the tool started, with the page's terminals and SSH sessions (the MCP tools' own sessions stay); the app's own server and another running pi-bay stay up (`stopped: false`).

### Security and Sandboxing

- Remote file paths are constrained to `$HOME` and path traversal (`..`) is rejected.
- All state-mutating HTTP API requests require same-origin access, the `/api/mcp` switch included (it sits below that check).
- HTTP MCP needs its key (see "HTTP MCP key"); the web UI and `/api/*` have none, so `--ui off` is the way to expose only MCP on a LAN.
- Cross-origin MCP requests over HTTP are validated against origin headers.

## Testing

Run the test suite with:

```bash
npm test
```

The test suite covers:
- `test/lib.test.js`: MAC normalization, path sandboxing, CRC32, ZIP archives and ZIP restore parsing, Pi host detection, transport selection, text/binary heuristics, and content decoding.
- `test/server.test.js`: Static assets and UI hooks, README endpoints, session authentication protections (including upload and restore), cross-origin rejections, and device name and hostname order.
- `test/page.test.js`: the page's server connection handling (banner, menu, reconnect, rescan, lost session), run in a VM from the `// ── Server Connection ──` block of `page.html`.
- `test/mcp.test.js`: Protocol discovery, legacy initialization, tool schemas, path traversal security, HTTP `/mcp` routes, origin checks, `/api/mcp` toggle, stdio execution and detection, `pi_ui`, and busy ports.
