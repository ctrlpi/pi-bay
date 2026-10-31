# Pi Bay

[![Platform: Cross-Platform](https://img.shields.io/badge/platform-Cross--Platform-006400.svg)](#quick-start)
[![Version 0.9.33](https://img.shields.io/badge/version-0.9.33-blue.svg)](https://github.com/ctrlpi/pi-bay/tags)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](https://nodejs.org/)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP-006400.svg)](#mcp-server)
[![Tools: 12](https://img.shields.io/badge/tools-12-006400.svg)](#mcp-tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](https://github.com/ctrlpi/pi-bay/blob/main/LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![Build Status](https://github.com/ctrlpi/pi-bay/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/pi-bay/actions)

`pi-bay` is an **App** and **MCP Server** for managing Raspberry Pis and other SSH devices on a LAN: find them, browse and edit their files, and run commands in an SSH terminal.

## Quick start

Requires Node.js 20 or newer and SSH enabled on the target device.

```sh
npx @ctrlpi/pi-bay
```

Your browser will open automatically! If it doesn't, head to [http://localhost:8383](http://localhost:8383).

## Devices

- Finds Raspberry Pis and other SSH devices on the local network as the scan runs.
- Detects ctrlPi agents, including Picos and ESP32s.
- Shows each device's name, IP and MAC address, model, and ctrlPi version.
- Signs in over SSH and saves passwords in the system keychain.
- Disconnects, toggles a Pi's USB power, and reboots it from the menu.

## Files

- Browses the home folder over SFTP as a searchable, collapsible tree, with hidden files optional.
- Lists a selected folder's files with their sizes and modification dates.
- Creates, renames, moves, uploads, downloads, and recursively deletes files and folders.
- Opens text files, edits them in the browser, and formats JSON.
- Renders a Markdown preview.
- Detects binary files and offers them for download instead of displaying them as text.
- Uploads files and whole folders by drag and drop.
- Downloads and restores the home folder as a standard ZIP archive.
- Installs or updates the ctrlPi API (pi-gpio-api) on a Raspberry Pi.

## Run and terminal

- Runs `.py`, `.sh`, `.bash`, and `.js` files on the device from their own folder.
- Opens an interactive SSH shell in full color.
- Keeps the session open while you switch to **Files** and back.

## MCP server

pi-bay includes a dependency-free [Model Context Protocol](https://modelcontextprotocol.io/) server, enabled by default on Raspberry Pi hosts. On macOS and other non-Pi hosts, enable MCP in the user interface or with `--mcp-stdio` or `--mcp-http`.

### Agent configuration

In Claude Desktop, open **Settings → Developer → Edit Config** to get to the configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or the equivalent file on Windows or Linux), and add the server under `mcpServers` enabling stdio:

```json
"mcpServers": {
  "pi-bay": {
    "command": "npx",
    "args": ["-y", "@ctrlpi/pi-bay", "--mcp-stdio"]
  }
}
```

### Streamable HTTP

Use HTTP when the MCP client runs on another computer or Raspberry Pi:

```sh
npx @ctrlpi/pi-bay --mcp-http
```

The normal web interface remains available and MCP is served at `http://HOST:8383/mcp`. Configure the MCP agent to connect over HTTP, replacing `PI_HOST_ADDR` with the platform running pi-bay:

```json
"mcpServers": {
  "pi-bay": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://PI_HOST_ADDR:8383/mcp", "--allow-http"]
  }
}
```

`--allow-http` permits the connection over a trusted local network. On macOS and other non-Pi hosts, add `--host 0.0.0.0` when starting pi-bay to make it reachable from another computer. A Raspberry Pi listens on the LAN by default.

> **No authentication or TLS:** MCP tools can run shell commands, overwrite and delete files, install software, and reboot devices. HTTP mode is intended only for a trusted local network. Do not expose `/mcp` or pi-bay’s port directly to the internet.

The server supports MCP revision `2026-07-28` and the legacy initialize flow through `2025-03-26`. It uses plain JSON responses rather than SSE because it does not send server-initiated messages.

### Signing in

`pi_device_authenticate` is the only tool that takes a `username` and `password`. The other tools reuse its connection, or sign in again by themselves with:

1. **The keychain**: a password saved with `save_password: true` (or **Save password** in the app) in macOS Keychain or Linux Secret Service.
2. **SSH keys**: the SSH agent (`SSH_AUTH_SOCK`) and the default identity files (`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`).

When neither works, the tool asks the agent to call `pi_device_authenticate` first.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `pi_devices_list` | List discovered devices on the LAN with model, ctrlPi status, and saved credential availability. |
| `pi_device_info` | Get hardware model, OS, kernel, storage, memory, uptime, and ctrlPi details. |
| `pi_device_authenticate` | Sign in over SSH and optionally save the password to the system keychain. |
| `pi_command_run` | Run a shell command and return its output and exit code, with a timeout (default 30 s, max 5 min). |
| `pi_files_list` | List one folder relative to `$HOME`, optionally with hidden files. |
| `pi_file_read` | Read a file as UTF-8 text or base64. |
| `pi_file_write` | Create or overwrite a UTF-8 or base64 file, up to 16 MB, creating missing parent folders. |
| `pi_directory_create` | Create a folder relative to `$HOME`. |
| `pi_path_rename` | Rename or move a file or folder relative to `$HOME`. |
| `pi_path_delete` | Permanently delete a file or recursively delete a folder relative to `$HOME`. |
| `pi_device_reboot` | Reboot the device. |
| `pi_ctrlpi_install` | Install or update the ctrlPi API (pi-gpio-api), and start its service when sudo needs no password. |

Call `pi_devices_list` first, then pass its `device_id` to device-specific tools.

## Installing the ctrlPi API

**Install ctrlPi API** in the top-right menu installs [`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api) on the connected Pi. A popup asks for the agent name, the API key, and the **Lite** (recommended) or **Full** package. pi-bay writes `~/pi-gpio-api/config.json` with the name and key, then runs the installer in the **Terminal** tab so you can follow it.

If the Pi already has `~/pi-gpio-api/config.json`, its agent name and API key are kept and the installer updates pi-gpio-api in place. The installer ends with the `sudo` commands that create and start the `pi-gpio-api` service, or restart it; run them in the same terminal.

The `pi_ctrlpi_install` MCP tool does the same without the terminal. On a first install a missing name or key gets the installer's defaults, the hostname and `your-secret-key`, and the result warns about the default key. On a Raspberry Pi where `sudo` needs no password it then creates and starts, or restarts, the service itself; otherwise it returns the installer's output with the commands to run.

## Toggling USB power

**Toggle Pi USB Power** in the top-right menu turns off every USB port on the connected Pi that supports power switching, then turns them back on after 3 seconds, using `uhubctl`. A popup explains what will happen and, when `uhubctl` is missing, that it is installed first with `apt`. The commands run in the **Terminal** tab, where `sudo` can ask for your password. It is refused on a Pi that boots from a USB drive, since cutting its USB power would crash it.

## Working with files

- After login, opens the home folder's only folder with its first entry selected, or selects the home folder when it has several folders or none.
- Selecting a folder lists its files on the right with name, size and modification date; click any row to open that file or folder. The toolbar then offers **Rename** and **Delete** for the folder.
- **Edit** (or a double-click on the open file) switches to the editor, which shows only **Format JSON** (for `.json` files), **Cancel** and **Save**. **Format JSON** reformats with 3-space indentation.
- **Run** runs the open `.py`, `.sh`, `.bash`, or `.js` file in the **Terminal** tab from the file's own folder: `python3 file.py`, `./file.sh`, or `node file.js`.
- **Move to folder…** in the file toolbar moves the open file to any folder already shown in the tree.
- **New file…**, **New folder…**, **Upload files…** and **Upload folder…** work in the selected folder (or the open file's folder). pi-bay asks before overwriting files it already shows.
- Deleting the open file selects the folder it was in. File and folder rows in the tree have a delete button.
- The browser tab names the open file or selected folder.

### Drag and drop

- Drop files or whole folders from your computer onto the file tree to upload them. Dropped on a folder row, they go into that folder; dropped on a file row, into that file's folder; anywhere else, into `$HOME`. Folder structure is kept and missing folders are created.
- Drop files onto a selected folder's listing on the right to upload them into that folder.
- Drop a file onto an open text file to put its text in the editor; nothing is written until **Save**.
- Drag a file or folder onto another folder to move it there, or onto an empty part of the tree to move it to `$HOME`.
- Drag a file out of the window onto your desktop to download it (Chrome and Edge).

## Requirements

- Node.js 20 or newer.
- macOS or Linux.
- SSH enabled on each device, on a trusted local network that permits discovery and SSH access.
- For saved passwords on Linux, `secret-tool` (Secret Service).

## Install

From GitHub:

```bash
git clone https://github.com/ctrlpi/pi-bay.git
cd pi-bay
npm start
```

Or install the npm package locally:

```bash
npm install @ctrlpi/pi-bay
npx pi-bay
```

## Options

```text
pi-bay [--port PORT] [--host ADDRESS] [--allow-host NAME] [--ssh-port PORT] [--api-port PORT] [--api-key KEY] [--no-open] [--mcp-stdio | --mcp-http | --no-mcp] [--help] [--version]
```

<table width="100%">
  <thead>
    <tr>
      <th width="20%">Option</th>
      <th width="20%">Environment</th>
      <th width="13%">Default</th>
      <th width="47%">Purpose</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="20%"><code>--port</code></td>
      <td width="20%"><code>PORT</code></td>
      <td width="13%"><code>8383</code></td>
      <td width="47%">Web server port.</td>
    </tr>
    <tr>
      <td width="20%"><code>--host</code></td>
      <td width="20%"><code>PI_BAY_HOST</code></td>
      <td width="13%">Automatic</td>
      <td width="47%"><code>127.0.0.1</code> normally; <code>0.0.0.0</code> on a Raspberry Pi host.</td>
    </tr>
    <tr>
      <td width="20%"><code>--allow-host</code></td>
      <td width="20%"><code>PI_BAY_ALLOW_HOSTS</code></td>
      <td width="13%">-</td>
      <td width="47%">Extra host name to accept, such as <code>pi4.lan</code>. Repeat the flag, or separate names with commas. IP addresses, <code>localhost</code> and the machine's own name always work.</td>
    </tr>
    <tr>
      <td width="20%"><code>--ssh-port</code></td>
      <td width="20%"><code>PI_BAY_SSH_PORT</code></td>
      <td width="13%"><code>22</code></td>
      <td width="47%">SSH port checked during discovery and used for connections.</td>
    </tr>
    <tr>
      <td width="20%"><code>--api-port</code></td>
      <td width="20%"><code>PI_BAY_API_PORT</code></td>
      <td width="13%"><code>8314</code></td>
      <td width="47%">ctrlPi API port.</td>
    </tr>
    <tr>
      <td width="20%"><code>--api-key</code></td>
      <td width="20%"><code>PI_BAY_API_KEY</code></td>
      <td width="13%"><code>your-secret-key</code></td>
      <td width="47%">API key used for <code>/config/read</code>.</td>
    </tr>
    <tr>
      <td width="20%"><code>--no-open</code></td>
      <td width="20%"><code>PI_BAY_NO_OPEN</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Do not automatically open the default browser on start. Browsers are never opened automatically on Raspberry Pi hosts.</td>
    </tr>
    <tr>
      <td width="20%"><code>--mcp-stdio</code></td>
      <td width="20%"><code>PI_BAY_MCP_STDIO</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Run only the MCP stdio transport. No web server or browser is started.</td>
    </tr>
    <tr>
      <td width="20%"><code>--mcp-http</code></td>
      <td width="20%"><code>PI_BAY_MCP_HTTP</code></td>
      <td width="13%">Pi only</td>
      <td width="47%">Add Streamable HTTP MCP at <code>/mcp</code> to the normal web server. Enabled automatically on Raspberry Pi hosts.</td>
    </tr>
    <tr>
      <td width="20%"><code>--no-mcp</code></td>
      <td width="20%"><code>PI_BAY_NO_MCP</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Disable all MCP transports, including the Raspberry Pi HTTP default.</td>
    </tr>
    <tr>
      <td width="20%"><code>--help</code></td>
      <td width="20%">-</td>
      <td width="13%">-</td>
      <td width="47%">Show command-line help.</td>
    </tr>
    <tr>
      <td width="20%"><code>--version</code></td>
      <td width="20%">-</td>
      <td width="13%">-</td>
      <td width="47%">Show the installed version.</td>
    </tr>
  </tbody>
</table>

Command-line values take precedence over environment variables.
Boolean environment variables accept `true` or `false`, and `1` or `0`.

## Running on a Raspberry Pi

On Linux, pi-bay checks `/proc/device-tree/model`. When the host is a Raspberry Pi, it listens on `0.0.0.0` by default so another computer on the same network can open it. It does not try to launch a browser on the Pi itself, and Streamable HTTP MCP is enabled at `/mcp` by default. Start with `--no-mcp` to disable MCP while keeping the web interface available, or switch MCP off from the top-right menu while it runs.

Only expose pi-bay on a trusted network. It has no login of its own and can run commands on, and change files of, every device it has signed in to.

## How discovery works

- The scan covers the `/24` network of the address the computer uses to reach other networks (offline, its first active IPv4 interface) and checks SSH on port 22 (`--ssh-port`) and a ctrlPi agent's `/hello` on port 8314 (`--api-port`).
- Names come from ctrlPi, reverse DNS, and on macOS from Bonjour and SMB/NetBIOS.
- A device is verified as a Raspberry Pi by its MAC vendor or a `raspberrypi` hostname. A ctrlPi agent without SSH is shown as an ESP32 when its model or name says so, and as a Pico otherwise. Other SSH hosts are marked unverified.
- For a ctrlPi agent, pi-bay reads `/config/read` with the configured API key: the model (`agent.platform`), operating system (`agent.os`) and version (`agent.version`). Live scan information is preferred; a previously saved model is used when the device does not return one. After SSH login, pi-bay also reads the Raspberry Pi model from Linux and saves it for future scans.

## Saved information

`~/.ctrlpi/pi-bay-devices.json` stores device identity, username, model, and whether a saved password exists. It is written with mode `0600` and lives outside the app folder, so reinstalling or upgrading pi-bay keeps it.

Passwords are not written to this file. They are stored in macOS Keychain or Linux Secret Service, and with a saved password **Connect** works with the password field left empty. A password used without **Save password** stays in memory for the current session only.

## Backups

**Download as ZIP** creates a standard archive of the home folder. **Restore from ZIP** extracts an archive into the home folder, overwrites matching paths, and leaves other files untouched. Keep a separate copy of important files before restoring.

## Security

pi-bay can run commands, overwrite and delete files, install software, and reboot devices. It is intended for a trusted local workstation and LAN.

- The server listens on `127.0.0.1` by default, or `0.0.0.0` when the host is a Raspberry Pi.
- Requests must be addressed to an IP address, `localhost`, the machine's own name (or `<name>.local`), or a name given with `--allow-host`. Any other name gets `403`, which blocks DNS rebinding: a web page cannot point its own domain at your machine and drive pi-bay through it. The terminal's WebSocket is checked the same way.
- State-changing requests require same-origin access.
- Remote file paths are restricted to the authenticated user's home directory and traversal paths are rejected.
- SSH host keys are accepted automatically without interactive verification.
- The app has no authentication, TLS, authorization, or multi-user isolation.

Do not expose it to an untrusted network, and connect only to devices you trust.

## Troubleshooting

### No device appears

- pi-bay scans only the `/24` network of the address the computer uses to reach other networks. Devices on another subnet or VLAN are not found; with a VPN that routes all traffic, the VPN's address is used, so disconnect it to scan the local network.
- Check that SSH is enabled on the Pi (`sudo raspi-config` → **Interface Options** → **SSH**) and listening on port 22, or start pi-bay with `--ssh-port`.
- Click the scan button again after a Pi has finished booting.

### Login fails

- The default username is `pi`; current Raspberry Pi OS images use the username chosen when the card was written.
- A saved password that no longer works is replaced the next time you log in with **Save password** selected.
- An MCP tool that says to sign in needs `pi_device_authenticate` first, or a saved password.

### Upload, move, or restore fails

The SSH user needs write permission for the target folder. Files outside `$HOME` cannot be changed from pi-bay's file browser; use the **Terminal** tab with `sudo` instead.

### The ctrlPi agent does not start after installing

The installer only prints the `sudo` commands for the `pi-gpio-api` service. Run them in the **Terminal** tab. `pi_ctrlpi_install` runs them itself only when `sudo` needs no password, and reports `needs_sudo` otherwise.

## Tests

Run the test suite with:

```bash
npm test
```

The test suite covers parsing, device discovery, HTTP and MCP APIs (MCP over stdio and HTTP), DNS-rebinding and cross-origin protection, sign-in checks, path safety, text and binary detection, the MCP tools' argument checks, and ZIP handling and restore. It needs no device on the network.

## Known limits

- ZIP download: up to 500 files and 100 MB, skipping files over 20 MB.
- ZIP restore: up to 64 MB, 4096 files, and 256 MB unpacked.
- Dragging a file out to download it works in Chromium-based browsers only.
- Saved passwords are not supported on Windows.

## Related projects

- **[`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api)**: Raspberry Pi GPIO REST server that reads inputs and drives outputs (and named sensors) over an HTTP API.
- **[`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api)**: Raspberry Pi Pico W port of the GPIO REST server, with the same endpoints, wire format, and auth.
- **[`esp32-gpio-api`](https://github.com/ctrlpi/esp32-gpio-api)**: ESP32 port of the GPIO REST server for MicroPython, with the same endpoints, wire format, and auth.
- **[`mcp-bridge`](https://github.com/ctrlpi/mcp-bridge)**: MCP server that exposes GPIO control as tools for AI agents (e.g. Claude), executing them over the agents' REST API.
- **[`homebridge-ctrlpi`](https://github.com/ctrlpi/homebridge-ctrlpi)**: A Homebridge plugin that brings Raspberry Pi, Pico W, and ESP32 GPIO into Apple Home, by driving one or more GPIO agents over their REST API.
- **`matter-bridge`** *(coming soon)*: Matter bridge that exposes GPIO pins and sensors to any Matter platform (Apple Home, Google Home, Alexa, Home Assistant), driven over the agents' REST API.
- **[`ctrlpi-cli`](https://github.com/ctrlpi/ctrlpi-cli)**: Command-line interface for interacting with ctrlPi agents, with shared agent configuration.
- **[`ctrlpi-lab`](https://github.com/ctrlpi/ctrlpi-lab)**: A local browser dashboard for your ctrlPi setup. Test GPIO and sensor endpoints, watch webhook events, and tail agent logs.
- **[`pico-bay`](https://github.com/ctrlpi/pico-bay)**: An app and MCP server for managing Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython over USB.

## License

[MIT](https://github.com/ctrlpi/pi-bay/blob/main/LICENSE)
