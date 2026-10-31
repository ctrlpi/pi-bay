#!/usr/bin/env python3
"""Scan the local /24 network for hosts answering SSH (port 22).

Lists the IP and name of every host with port 22 open, flags the ones that
look like a Raspberry Pi (by MAC OUI, read from the ARP table after the
probe), and flags those running the ctrlPi GPIO server (`/hello` on port
8314). A host is listed if it answers SSH or `/hello`. Standard library only.

For each ctrlPi host it also tries `/config/read` with the API key, which both
validates the key and reads the agent's software version for the Version
column. The version lives behind auth, so a host on a different key shows
`wrong key` and no version.

Names are resolved (in order): the ctrlPi `/hello` device name, reverse DNS,
then the SMB/NetBIOS name (the kind macOS shows in the Network folder).

    python search.py                 # scan the auto-detected local /24
    python search.py --port 22       # override the SSH port
    python search.py --api-port 8314 # override the ctrlPi /hello port
"""
import argparse
import concurrent.futures
import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request

# ANSI colors, auto-disabled when stdout is not a terminal.
_COLOR = sys.stdout.isatty()
RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
GREEN, RED, CYAN, MAGENTA, BLUE = (
    "\033[32m", "\033[31m", "\033[36m", "\033[35m", "\033[34m")


def paint(text, *codes):
    if not _COLOR or not codes:
        return text
    return "".join(codes) + text + RESET


def flag(value, width=0):
    """Render a yes/no cell, padded to width, green for yes and red for no."""
    text = ("yes" if value else "no").ljust(width)
    return paint(text, GREEN if value else RED)

# Raspberry Pi MAC OUI prefixes (Raspberry Pi Foundation / Trading / Ltd).
PI_OUIS = {
    "b8:27:eb",
    "dc:a6:32",
    "e4:5f:01",
    "28:cd:c1",
    "d8:3a:dd",
    "2c:cf:67",
    "3a:35:41",
    "88:a2:9e",  # Raspberry Pi 5
    "ba:fb:b3",  # specific Pi with a locally-administered (randomized) MAC
}


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


# Sweep timing: a Zero 2 W or Pico needs 1.5 s to answer, and a Pico serves one
# connection at a time, so probes run 48 at a time.
SCAN_TIMEOUT = 1.5   # seconds
SCAN_BATCH = 48      # concurrent probes


def check_port(host, port, timeout=SCAN_TIMEOUT):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def check_hello(host, port, timeout=SCAN_TIMEOUT):
    """Return (is_ctrlpi, device_name) from the /hello probe."""
    try:
        with urllib.request.urlopen(
            f"http://{host}:{port}/hello", timeout=timeout
        ) as r:
            if r.status != 200:
                return False, None
            name = json.loads(r.read().decode()).get("name")
            return True, name
    except Exception:
        return False, None


def check_key(host, port, api_key, timeout=SCAN_TIMEOUT):
    """Validate api_key against an authed endpoint and read the agent's version.

    Returns (key_ok, version). key_ok is True/False, or None if unknown. version is the
    agent's reported software version, or None when it couldn't be read - it lives in
    /config/read's `agent` block, so a wrong key means no version either. Same timeout as
    the rest of the sweep: /config/read is a bigger reply than /hello, and a Pico serving
    one connection at a time needs the full window.
    """
    req = urllib.request.Request(
        f"http://{host}:{port}/config/read", headers={"Api-Key": api_key}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None, None
            try:
                agent = json.loads(r.read().decode()).get("agent") or {}
                return True, agent.get("version") or None
            except Exception:
                return True, None      # key worked, body unreadable
    except urllib.error.HTTPError as e:
        return (False if e.code in (401, 403) else None), None
    except Exception:
        return None, None


def scan_network(ssh_port, api_port, api_key):
    """Return {ip: {ssh, ctrlpi, ctrlpi_name, key_ok, version}} for hosts answering either."""
    local_ip = get_local_ip()
    if not local_ip:
        print("Could not determine local IP address.")
        return {}
    prefix = ".".join(local_ip.split(".")[:3])
    print(f"Scanning {prefix}.0/24 for SSH (port {ssh_port}) "
          f"and ctrlPi /hello (port {api_port})...")

    def check(i):
        host = f"{prefix}.{i}"
        ssh = check_port(host, ssh_port)
        ctrlpi, name = check_hello(host, api_port)
        if not (ssh or ctrlpi):
            return None
        # Only ctrlPi hosts have an authed API to validate the key against - and the
        # version comes out of the same /config/read, so it needs the key to work.
        key_ok, version = check_key(host, api_port, api_key) if ctrlpi else (None, None)
        return host, {"ssh": ssh, "ctrlpi": ctrlpi, "ctrlpi_name": name,
                      "key_ok": key_ok, "version": version}

    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_BATCH) as executor:
        results = list(executor.map(check, range(1, 256)))
    return {host: flags for host, flags in (r for r in results if r)}


def normalize_mac(mac):
    """Zero-pad each octet so OUI comparison is reliable (macOS strips zeros)."""
    try:
        return ":".join(f"{int(p, 16):02x}" for p in mac.split(":"))
    except ValueError:
        return mac.lower()


def arp_table():
    """Return {ip: normalized_mac} parsed from the system ARP cache."""
    table = {}
    try:
        out = subprocess.run(
            ["arp", "-an"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return table
    pair = re.compile(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+)")
    for ip, mac in pair.findall(out):
        if mac.lower() != "(incomplete)":
            table[ip] = normalize_mac(mac)
    return table


def smb_name(ip):
    """NetBIOS/SMB name via `smbutil` (the name macOS shows in Network)."""
    try:
        out = subprocess.run(
            ["smbutil", "status", "-a", ip],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        parts = line.split()
        # The 0x00 UNIQUE row is the workstation's own NetBIOS name.
        if len(parts) >= 3 and parts[1] == "0x00" and parts[2] == "UNIQUE":
            return parts[0]
    return None


def _dns_sd(args, seconds):
    """Run `dns-sd` for a bounded time and return its output (it never exits)."""
    try:
        out = subprocess.run(
            ["dns-sd", *args], capture_output=True, text=True, timeout=seconds
        ).stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout or ""        # we kill dns-sd; partial output is what we want
    except Exception:
        return ""
    return out.decode(errors="ignore") if isinstance(out, bytes) else out


# Bonjour service types whose instance name is the device's advertised name.
# _afpovertcp = netatalk (older Apple file sharing), _smb = Samba.
BONJOUR_SERVICES = ["_afpovertcp._tcp", "_smb._tcp", "_ssh._tcp", "_workstation._tcp"]


def bonjour_names():
    """Map {ip: advertised_name} by browsing Bonjour and resolving to addresses."""
    # 1. Browse every service in parallel -> unique (instance, service) pairs.
    def browse(svc):
        found = []
        for line in _dns_sd(["-B", svc, "local"], 3).splitlines():
            idx = line.find(svc + ".")
            if " Add " in line and idx != -1:
                inst = line[idx + len(svc) + 1:].strip()
                if inst:
                    found.append((inst, svc))
        return found

    instances = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        for found in ex.map(browse, BONJOUR_SERVICES):
            instances.update(found)

    # 2. Resolve each instance to its <host>.local target.
    def to_host(item):
        inst, svc = item
        out = _dns_sd(["-L", inst, svc, "local"], 2)
        m = re.search(r"reached at ([A-Za-z0-9._-]+\.local)\.?:", out)
        return (m.group(1), inst) if m else None

    host_name = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
        for r in ex.map(to_host, instances):
            if r:
                host_name.setdefault(r[0], r[1])

    # 3. Resolve each <host>.local to an IPv4 address.
    def to_ip(host):
        for line in _dns_sd(["-G", "v4", host], 2).splitlines():
            m = re.search(r"\b(\d+\.\d+\.\d+\.\d+)\b", line)
            if "Add" in line and m and m.group(1) != "0.0.0.0":
                return m.group(1), host_name[host]
        return None

    names = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
        for r in ex.map(to_ip, list(host_name)):
            if r:
                # _workstation advertises "name [00:11:22:..]"; strip only for display.
                names[r[0]] = re.sub(r"\s*\[[0-9a-fA-F:]+\]\s*$", "", r[1])
    return names


def resolve_name(ip, bonjour):
    """Host's network name: reverse DNS, then Bonjour (SMB/AFP), then SMB/NetBIOS."""
    try:
        return socket.gethostbyaddr(ip)[0]
    except Exception:
        pass
    return bonjour.get(ip) or smb_name(ip) or "-"


def is_pi(mac, name):
    # A Pi is recognised by its MAC vendor, or by the default `raspberrypi` hostname.
    if mac and mac[:8] in PI_OUIS:      # may miss MAC-randomized Pis
        return True
    return name.lower().startswith("raspberrypi")


def main():
    parser = argparse.ArgumentParser(
        description="Find hosts on the local network that answer SSH or the "
                    "ctrlPi /hello probe."
    )
    parser.add_argument(
        "--port", type=int, default=22, help="SSH port to probe (default: 22)"
    )
    parser.add_argument(
        "--api-port", type=int, default=8314,
        help="ctrlPi /hello port to probe (default: 8314)"
    )
    parser.add_argument(
        "--api-key", default="your-secret-key",
        help="API key to validate against ctrlPi hosts, and to read their version "
             "from /config/read (default: your-secret-key)"
    )
    args = parser.parse_args()

    hosts = scan_network(args.port, args.api_port, args.api_key)
    if not hosts:
        print("No hosts answered on SSH or the ctrlPi port.")
        return

    arp = arp_table()
    bonjour = bonjour_names()
    ordered = sorted(hosts, key=lambda h: tuple(int(o) for o in h.split(".")))

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        names = dict(zip(ordered, executor.map(
            lambda ip: resolve_name(ip, bonjour), ordered)))

    rows = []
    for ip in ordered:
        name = names[ip] or "-"
        mac = arp.get(ip, "")
        flags = hosts[ip]
        rows.append((ip, name, mac, is_pi(mac, name),
                     flags["ssh"], flags["ctrlpi"],
                     flags["ctrlpi_name"], flags["key_ok"], flags["version"]))

    name_w = max(len("Name"), *(len(r[1]) for r in rows))
    ver_w = max(len("Version"), *(len(r[8] or "-") for r in rows))
    print()
    print(paint(f"{'IP':<15}  {'Name':<{name_w}}  {'MAC':<17}  Pi?  SSH  "
                f"{'Version':<{ver_w}}  ctrlPi", BOLD, CYAN))
    print(paint(f"{'-' * 15}  {'-' * name_w}  {'-' * 17}  ---  ---  "
                f"{'-' * ver_w}  ------", DIM))
    for ip, name, mac, pi, ssh, ctrlpi, ctrlpi_name, key_ok, version in rows:
        name_cell = paint(name.ljust(name_w), MAGENTA) if pi else name.ljust(name_w)
        # ctrlPi cell: "yes - <name>", or "yes - wrong key" (red) if the key
        # was rejected, else red "no".
        if ctrlpi:
            ctrlpi_cell = paint("yes", GREEN)
            if key_ok is False:
                ctrlpi_cell += f" - {paint('wrong key', RED)}"
            elif ctrlpi_name:
                ctrlpi_cell += f" - {paint(ctrlpi_name, BLUE)}"
        else:
            ctrlpi_cell = paint("no", RED)
        # Version only exists where the key opened /config/read; everywhere else it is
        # a dim "-" rather than blank, so the column reads as "not available", not "0".
        ver_cell = (paint(version.ljust(ver_w), CYAN) if version
                    else paint("-".ljust(ver_w), DIM))
        print(f"{ip:<15}  {name_cell}  {mac or '-':<17}  "
              f"{flag(pi, 3)}  {flag(ssh, 3)}  {ver_cell}  {ctrlpi_cell}")

    pi_count = sum(1 for r in rows if r[3])
    ctrlpi_count = sum(1 for r in rows if r[5])
    print(f"\nFound {paint(str(len(rows)), BOLD)} host(s) "
          f"({paint(str(pi_count), MAGENTA)} Raspberry Pi, "
          f"{paint(str(ctrlpi_count), GREEN)} running ctrlPi).")


if __name__ == "__main__":
    main()
