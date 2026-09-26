#!/usr/bin/env bash
# Install the keys that setup.sh wrote into /etc/workbench, then run sshd.
#
#   /etc/workbench/ssh_host_ed25519_key   the host key of the workstation
#   /etc/workbench/keys/<account>.pub     the key of each account
#
# The host key goes to a root-only copy: sshd refuses a host key that other
# users can read, and a bind mount keeps the owner of the machine outside.
set -euo pipefail

SOURCE=/etc/workbench
CONFIG=/etc/ssh/sshd_workbench_config
mapfile -t ACCOUNTS < <(grep -v '^#' /etc/workbench-accounts)
GIT_ACCOUNT=workbench-git

if ! [ -f "$SOURCE/ssh_host_ed25519_key" ]; then
	echo "workstation: no host key in $SOURCE. Run workstation/setup.sh first." >&2
	exit 1
fi
install -d -m 0700 /etc/ssh/workbench
install -m 0600 "$SOURCE/ssh_host_ed25519_key" /etc/ssh/workbench/ssh_host_ed25519_key

# Each account gets its one public key. The git backend writes the keys of
# the agents into authorized_keys.ambion of the git account, and this script
# leaves that file alone.
for name in "${ACCOUNTS[@]}" "$GIT_ACCOUNT"; do
	key="$SOURCE/keys/$name.pub"
	if ! [ -f "$key" ]; then
		echo "workstation: no key for $name in $SOURCE/keys. Run workstation/setup.sh again." >&2
		exit 1
	fi
	home="$(getent passwd "$name" | cut -d: -f6)"
	install -d -m 0700 -o "$name" -g "$name" "$home/.ssh"
	install -m 0600 -o "$name" -g "$name" "$key" "$home/.ssh/authorized_keys"
done

# The layout of the workspace. Every agent writes the audit log as itself:
# the setgid bit keeps the group on each new file, and the default ACL keeps
# it writable for the group whatever umask a tool has. The default ACL gives
# `rwx`: a new folder keeps the search bit, and a new file gets `rw`, because
# its create mode has no execute bit. Only the host account writes the room
# mirror and /library, and every account reads them. Every account writes
# /shared. A named volume drops the ACLs of the image, so the script sets
# them at each start. `X` gives the search bit to folders alone.
install -d -m 2770 -o root -g workbench /srv/workbench/audit /shared
setfacl -R -m g::rwX /srv/workbench/audit /shared
setfacl -d -m g::rwx /srv/workbench/audit /shared
install -d -m 2750 -o workbench-host -g workbench /srv/workbench/rooms /library

# The USB devices of the machine, when compose.yaml mounts /dev/bus/usb. The
# container runs no udev, so each device file comes in as root's. The group
# plugdev gets read and write, so Instruments reaches a device through
# libusb. A device attached after the start gets a file of its own, so a
# loop in the background applies the rule again every 5 seconds.
usb_access() {
	[ -d /dev/bus/usb ] || return 0
	chgrp -R plugdev /dev/bus/usb 2>/dev/null || true
	chmod -R g+rw /dev/bus/usb 2>/dev/null || true
}
usb_access
( while sleep 5; do usb_access; done ) &

# The account list decides who logs in. The Match block of the git account
# adds the keys that the git backend issues.
cp "$CONFIG" /etc/ssh/sshd_workbench_config.run
cat >>/etc/ssh/sshd_workbench_config.run <<CONF
AllowUsers ${ACCOUNTS[*]} $GIT_ACCOUNT
Match User $GIT_ACCOUNT
	AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.ambion
CONF

/usr/sbin/sshd -t -f /etc/ssh/sshd_workbench_config.run
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_workbench_config.run
