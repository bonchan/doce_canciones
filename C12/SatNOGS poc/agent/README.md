# SatNOGS installation agent

One per display computer (Linux Mint / XFCE). It opens a full-screen browser on each screen,
opens it again if it closes, keeps the screens from blanking, and joins core2's MQTT bus as a
device of type `computer.satnogs` in zone `satnogs`, next to the installation server
(`installation.satnogs`). core2's device page for it shows, per screen: plugged in, getting a
picture, awake or blanked, browser running, page connected, and showing (drawing frames).

## Setup, on each computer

1. Copy this project over with git, so the scripts keep Linux line endings.
2. On the computer that runs the server and the listener: install Node 20+ and pnpm first, then
   `bash install.sh --server`. On the others: `bash install.sh`.
3. The first run creates `agent.ini` from `agent.example.ini`. Set the broker (and its user and
   password), this computer's `name`, the installation server's `url`, and one line per screen
   (output names from `xrandr --query`). Run `bash install.sh` again.
4. Mint: Login Window > Users > automatic login for this user, so the screens start by
   themselves after power on.

Logs: `journalctl --user -u satnogs-agent -f` (and `-u satnogs-installation`, `-u satnogs-listener`
on the server computer). After editing `agent.ini`: `systemctl --user restart satnogs-agent`.

## Nights

Either from core2 (the computer's page: "Power off until" a time), or a daily schedule in
`agent.ini` (`[schedule]` `on` / `off`). Both power off properly and set the computer's clock
alarm (`rtcwake`) to turn it back on in the morning. Check once that it does: some BIOSes need
"wake on RTC alarm" enabled. If the venue cuts mains power at night instead, set the BIOS to
power on when power returns.

## The disks

Old hard disks wear from writes and from losing power mid-write, not from running hours. The
browsers' profiles and caches already live in RAM (`/dev/shm`). To cut most of the rest:

- system logs in RAM: `Storage=volatile` in `/etc/systemd/journald.conf`
- `noatime` on the root filesystem in `/etc/fstab`
- `vm.swappiness=10` in `/etc/sysctl.d/99-satnogs.conf`, so 4 GB doesn't swap to disk

The agent reports the disk's SMART verdict (ok / failing) every 10 minutes; check
`sudo smartctl -a /dev/sda` once before the installation (reallocated or pending sectors: use
another disk).
