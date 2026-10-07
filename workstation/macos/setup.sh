#!/usr/bin/env bash
# Set up a Workbench workstation on this Mac, for the OS users of the seats:
#
#   sudo bash workstation/macos/setup.sh [state-dir]     # .workstation by default
#
# An admin runs the script with sudo. It makes one hidden OS user for each
# account of workstation/accounts and for the git account, a group for the
# seats, the folders of the workspace, and a drop-in file for the sshd of
# this Mac. Workbench then reaches the workstation on 127.0.0.1, port 22,
# the same as it reaches the container of workstation/setup.sh. The script
# keeps what exists, so a second run changes nothing. teardown.sh undoes it.
# Each check runs before the first change, so a script that stops on a check
# leaves nothing behind.
#
# To use other ids, run: sudo WORKBENCH_UID_BASE=6000 bash workstation/macos/setup.sh
#
# The script writes <state-dir>/macos.json, which WORKBENCH_WORKSTATION
# names, and <state-dir>/macos.known_hosts. It keeps the files that the
# container uses. The files in the state folder belong to the admin.
#
# WORKBENCH_DRY_RUN=1 prints each privileged command and writes nothing
# outside the state folder. workstation/macos/README.md describes the setup.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

STATE="${1:-$REPO/.workstation}"
GNUBIN=""
SEAT_PATH=""
UID_HINT="WORKBENCH_UID_BASE=6000"
SELF_ACCOUNT=engineer
PYTHON_FLOOR="$(sed -n 's/^target-version *= *"py\([0-9]\)\([0-9][0-9]*\)".*/\1.\2/p' "$REPO/pyproject.toml")"

# The account ids, one "name uid" pair on each line.
account_ids() {
	local i=0 name
	for name in "${ACCOUNTS[@]}"; do
		echo "$name $((UID_BASE + i))"
		i=$((i + 1))
	done
	echo "$GIT_ACCOUNT $GIT_UID"
}

new_uuid() {
	uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid
}

# The GNU tools. The backend of Ambion runs scripts that use `date -d`,
# `date +%s%3N`, `stat -c`, and `base64 -w0`. The tools of macOS take other
# options. Homebrew coreutils has the GNU tools in one folder, gnubin.
find_gnubin() {
	local candidate
	for candidate in "${WORKBENCH_GNUBIN:-}" /opt/homebrew/opt/coreutils/libexec/gnubin \
		/usr/local/opt/coreutils/libexec/gnubin; do
		if [ -n "$candidate" ] && [ -x "$candidate/date" ]; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

# The PATH that each seat gets in ~/.zshenv. The folder of the shims comes
# first, then the GNU tools, then Homebrew, where python3 of the right version is.
seat_path() {
	local path="$LIBEXEC/bin:$GNUBIN" dir
	for dir in /opt/homebrew/bin /usr/local/bin; do
		[ -d "$dir" ] && path="$path:$dir"
	done
	echo "$path"
}

preflight() {
	local tool
	if [ -z "$DRY" ]; then
		for tool in dscl dseditgroup sysadminctl sshd ssh ssh-keygen perl install nc; do
			command -v "$tool" >/dev/null || die "the command $tool is missing."
		done
		grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' "$SSHD_CONFIG" ||
			die "$SSHD_CONFIG has no Include line for /etc/ssh/sshd_config.d/. Add the line 'Include /etc/ssh/sshd_config.d/*' at the top of the file, and run this script again."
	fi
	[ -n "$HOST_ACCOUNT" ] || die "workstation/accounts names no host account (a name that ends in -host)."
	if GNUBIN="$(find_gnubin)"; then
		:
	elif [ -n "$DRY" ]; then
		GNUBIN=/opt/homebrew/opt/coreutils/libexec/gnubin
		warn "no GNU coreutils found. A real run stops here."
	else
		die "GNU coreutils are missing. The workstation backend needs GNU date, stat, and base64. Run as $ADMIN: brew install coreutils"
	fi
	SEAT_PATH="$(seat_path)"
	case " ${ACCOUNTS[*]} " in
	*" $SELF_ACCOUNT "*) ;;
	*) SELF_ACCOUNT="${ACCOUNTS[0]}" ;;
	esac
}

# Stop when an account or an id belongs to something that this script did not make.
check_ids() {
	local listing name uid have owner
	listing="$(dscl . -list /Users UniqueID 2>/dev/null || true)"
	while read -r name uid; do
		if user_exists "$name"; then
			user_marked "$name" ||
				die "the user $name exists, and this script did not make it. Rename or delete it first."
			have="$(user_uid "$name")"
			[ -z "$have" ] || [ "$have" = "$uid" ] ||
				die "the user $name exists with uid $have, and this script wants $uid. Delete the user, or run: sudo $UID_HINT bash $0"
			continue
		fi
		owner="$(printf '%s\n' "$listing" | awk -v id="$uid" '$2 == id { print $1; exit }')"
		[ -z "$owner" ] ||
			die "the uid $uid belongs to the user $owner. Use a free range of ids: sudo $UID_HINT bash $0"
		[ ! -e "$HOMES/$name" ] && [ ! -L "$HOMES/$name" ] ||
			die "the folder $HOMES/$name exists, and the user $name does not. Move the folder away, and run this script again."
	done < <(account_ids)
	if group_exists "$GROUP"; then
		group_marked "$GROUP" ||
			die "the group $GROUP exists, and this script did not make it. Rename or delete it first."
	else
		owner="$(dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk -v id="$GROUP_GID" '$2 == id { print $1; exit }' || true)"
		[ -z "$owner" ] ||
			die "the gid $GROUP_GID belongs to the group $owner. Use a free id: sudo WORKBENCH_GID=6000 bash $0"
	fi
}

# The numeric owner of a path, and its permission string. A link shows as
# itself: ls does not follow it.
path_uid() {
	# shellcheck disable=SC2012
	ls -ldn "$1" | awk '{ print $3 }'
}

path_mode() {
	# shellcheck disable=SC2012
	ls -ld "$1" | awk '{ print $1 }'
}

# Stop when a name in `/` clashes with a root link. macOS compares names
# without regard to case, so /Datasheets blocks /datasheets. The only entry
# that may carry the name is the link that this script made.
check_root_names() {
	local dir="${ROOT_DIR:-/}" name entry
	[ -d "$dir" ] || return 0
	for name in "${ROOT_NAMES[@]}"; do
		while IFS= read -r entry; do
			[ "$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')" = "$name" ] || continue
			if [ "$entry" = "$name" ] && [ -L "${dir%/}/$entry" ] &&
				[ "$(readlink "${dir%/}/$entry")" = "${SHARE#/}/$name" ]; then
				continue
			fi
			die "/$entry exists, and it clashes with the root link /$name. macOS compares names without regard to case. Move or rename /$entry, and run this script again. The script changed nothing."
		done < <(ls -A "$dir" 2>/dev/null)
	done
}

# Stop when the data folder, or the folder srv in it, is a link or has an
# owner other than root. Root writes below these folders. Another user must
# not control where they lead.
check_layout() {
	local folder
	for folder in "$SHARE" "$SHARE/srv"; do
		[ -e "$folder" ] || [ -L "$folder" ] || continue
		if [ -L "$folder" ] || [ ! -d "$folder" ]; then
			die "$folder exists and is not a plain folder. Move it away, and run this script again."
		fi
		[ "$(path_uid "$folder")" = "$ROOT_UID" ] ||
			die "$folder belongs to another user than root. Move it away, and run this script again."
		case "$(path_mode "$folder")" in
		?????-??-*) ;;
		*) die "$folder is writable for its group or for every user. Run 'sudo chmod 755 $folder', or move it away, and run this script again." ;;
		esac
	done
}

# Stop when the home of an account, or the folder .ssh in it, is a link or
# belongs to another user. The seat controls its own home. Root must not follow
# a link that the seat planted.
check_home() {
	local name="$1" uid="$2" path
	# A dry run runs as a normal user. The test sets WORKBENCH_OWNER_UID.
	[ -z "$DRY" ] || uid="${WORKBENCH_OWNER_UID:-$uid}"
	for path in "$HOMES/$name" "$HOMES/$name/.ssh"; do
		[ -e "$path" ] || [ -L "$path" ] || continue
		if [ -L "$path" ] || [ ! -d "$path" ]; then
			die "$path is not a plain folder. It may be a link that the user $name made. Move it away, and run this script again."
		fi
		[ "$(path_uid "$path")" = "$uid" ] ||
			die "$path does not belong to the user $name. Move it away, and run this script again."
	done
}

check_homes() {
	local name uid
	while read -r name uid; do
		check_home "$name" "$uid"
	done < <(account_ids)
}

# The state of Remote Login before the first run. teardown.sh puts it back.
record_state() {
	local before
	run install -d -m 0755 -o root -g wheel "$LIBEXEC" "$LIBEXEC/bin"
	if [ -f "$STATE_FILE" ]; then
		return 0
	fi
	before="$(remote_login_state)"
	say "Remote Login before setup: $before"
	put 0644 root:wheel "$STATE_FILE" <<EOF
remotelogin=$before
EOF
}

# One key for each account, in the same folder layout as workstation/setup.sh.
# A key that exists stays, so the container keeps working.
make_keys() {
	local name
	as_admin mkdir -p "$STATE/keys"
	STATE="$(cd "$STATE" && pwd)"
	as_admin chmod 0700 "$STATE" "$STATE/keys"
	while read -r name; do
		[ -f "$STATE/keys/$name" ] ||
			as_admin ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$STATE/keys/$name"
	done < <(all_accounts)
}

create_group() {
	if group_exists "$GROUP"; then
		say "group $GROUP: exists"
		return 0
	fi
	say "group $GROUP: create, gid $GROUP_GID"
	run dseditgroup -o create -r "Workbench seats" -i "$GROUP_GID" "$GROUP"
	run dscl . -create "/Groups/$GROUP" Comment "$MARK"
}

# One hidden standard user. The password is `*`, a value that no password
# gives. The record has no AuthenticationAuthority attribute, so it has no
# DisabledUser mark either: the account check of sshd passes, and a key
# opens the account. A password cannot, and the drop-in refuses it as well.
create_account() {
	local name="$1" uid="$2"
	if [ -n "$(user_uid "$name")" ]; then
		say "account $name: exists"
		return 0
	fi
	say "account $name: create, uid $uid"
	run dscl . -create "/Users/$name"
	run dscl . -create "/Users/$name" Comment "$MARK"
	run dscl . -create "/Users/$name" UserShell "$ACCOUNT_SHELL"
	run dscl . -create "/Users/$name" RealName "Workbench $name"
	run dscl . -create "/Users/$name" UniqueID "$uid"
	run dscl . -create "/Users/$name" PrimaryGroupID 20
	run dscl . -create "/Users/$name" NFSHomeDirectory "$HOMES/$name"
	run dscl . -create "/Users/$name" GeneratedUID "$(new_uuid)"
	run dscl . -create "/Users/$name" IsHidden 1
	run dscl . -create "/Users/$name" Password '*'
}

add_to_group() {
	local name="$1" group="$2"
	is_member "$name" "$group" || run dseditgroup -o edit -a "$name" -t user "$group"
}

# The home, the public key, and the PATH of one account. The key line holds
# the loopback addresses in `from=`: no other address logs in with it.
install_account_files() {
	local name="$1" home="$HOMES/$1" uid
	uid="$(account_ids | awk -v n="$name" '$1 == n { print $2 }')"
	check_home "$name" "$uid"
	# Root makes only a home that does not exist. The seat makes .ssh and
	# writes its own files, so a link in the home leads root nowhere.
	if [ ! -e "$home" ]; then
		run install -d -m 0700 -o "$name" -g "$PRIMARY_GROUP" "$home"
	fi
	run sudo -n -u "$name" -H install -d -m 0700 "$home/.ssh"
	put_seat "$name" 0600 "$home/.ssh/authorized_keys" <<EOF
from="127.0.0.1,::1" $(cat "$STATE/keys/$name.pub")
EOF
	put_seat "$name" 0644 "$home/.zshenv" <<EOF
# Written by workstation/macos/setup.sh. A non-interactive ssh session starts
# zsh, which reads this file. The PATH has the shims of setsid and flock, the
# GNU tools, and Homebrew.
export PATH="$SEAT_PATH:\$PATH"
EOF
}

# Make accounts, the group, and the homes.
make_accounts() {
	local name uid
	create_group
	while read -r name uid; do
		create_account "$name" "$uid"
	done < <(account_ids)
	for name in "${ACCOUNTS[@]}"; do
		add_to_group "$name" "$GROUP"
	done
	while read -r name; do
		install_account_files "$name"
	done < <(all_accounts)
}

# The ACL entries that keep a folder writable for the group whatever the umask
# of a tool is. The first entry covers the folder and each folder below it.
# The second covers each file below it. macOS gives a new file the group of its
# folder, so the group needs no setgid bit.
add_acl() {
	local folder="$1"
	# shellcheck disable=SC2010
	if ls -lde "$folder" 2>/dev/null | grep -q "group:$GROUP"; then
		return 0
	fi
	run chmod +a "group:$GROUP allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,directory_inherit" "$folder"
	run chmod +a "group:$GROUP allow read,write,append,readattr,writeattr,readextattr,writeextattr,file_inherit,directory_inherit" "$folder"
}

# The layout of entrypoint.sh, under /Users/Shared/workbench. Every seat writes
# the audit log and /shared. Only the host account writes the room mirror, the
# snapshots, /datasheets, and /attachments, and every seat reads them.
make_layout() {
	local folder
	check_layout
	run install -d -m 0755 -o root -g wheel "$SHARE" "$SHARE/srv"
	run install -d -m 0770 -o root -g "$GROUP" "$SHARE/srv/audit" "$SHARE/shared"
	for folder in "$SHARE/srv/audit" "$SHARE/shared"; do
		add_acl "$folder"
	done
	run install -d -m 0750 -o "$HOST_ACCOUNT" -g "$GROUP" "$SHARE/srv/rooms" \
		"$SHARE/srv/snapshots" "$SHARE/datasheets" "$SHARE/attachments"
}

# The three root folders are links in `/`, which is read-only on macOS.
# /etc/synthetic.conf is the supported way to add them. The script adds a
# line for each folder that has none, and keeps every other line.
make_root_links() {
	local name line current="" changed="" target
	[ -f "$SYNTHETIC" ] && current="$(cat "$SYNTHETIC")"
	for name in "${ROOT_NAMES[@]}"; do
		line="$(synthetic_line "$name")"
		target="$(printf '%s\n' "$current" | awk -F '\t' -v n="$name" '$1 == n { print $2; exit }')"
		if [ -n "$target" ] && [ "$target" != "${SHARE#/}/$name" ]; then
			die "$SYNTHETIC links /$name to $target already. Remove that line, and run this script again."
		fi
		[ -z "$target" ] || continue
		if [ -e "$ROOT_DIR/$name" ] && [ ! -L "$ROOT_DIR/$name" ]; then
			die "/$name exists and is not a link. Move it away, and run this script again."
		fi
		if [ -n "$current" ]; then
			current="$current"$'\n'"$line"
		else
			current="$line"
		fi
		changed=1
	done
	if [ -z "$changed" ]; then
		say "root links: in $SYNTHETIC"
	else
		printf '%s\n' "$current" | put 0644 root:wheel "$SYNTHETIC"
	fi
	say "root links: apply without a restart"
	try "$APFS_UTIL" -t || true
	if [ -z "$DRY" ]; then
		for name in "${ROOT_NAMES[@]}"; do
			if [ ! -L "/$name" ]; then
				warn "/$name does not exist yet. Restart the Mac, and the links appear."
				break
			fi
		done
	fi
}

install_shims() {
	put 0755 root:wheel "$LIBEXEC/bin/setsid" <"$HERE/shims/setsid"
	put 0755 root:wheel "$LIBEXEC/bin/flock" <"$HERE/shims/flock"
}

# The drop-in file for sshd. The sshd of this Mac keeps its port, its
# address, and its host key. The file changes only the accounts of the
# workstation. sshd keeps the first value of each keyword, and the block of
# the git account comes first, so it keeps its own AuthorizedKeysFile.
write_dropin() {
	local users
	users="$(all_accounts | paste -sd, -)"
	run install -d -m 0755 -o root -g wheel "$(dirname "$SSHD_DROPIN")"
	put 0644 root:wheel "$SSHD_DROPIN" <<EOF
# Written by workstation/macos/setup.sh. teardown.sh removes this file.
# The git account also reads the keys that the git backend of Ambion writes
# to authorized_keys.ambion.
Match User $GIT_ACCOUNT
	AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.ambion
# Each account of the workstation logs in with a key and nothing else. The
# git backend of Ambion forwards ports through ssh, so forwarding stays on.
Match User $users
	PubkeyAuthentication yes
	AuthenticationMethods publickey
	PasswordAuthentication no
	KbdInteractiveAuthentication no
	AuthorizedKeysFile .ssh/authorized_keys
	AllowTcpForwarding yes
EOF
	if [ -z "$DRY" ]; then
		if ! sshd -t; then
			rm -f "$SSHD_DROPIN"
			die "sshd refused the new file. The script removed $SSHD_DROPIN."
		fi
	else
		run sshd -t
	fi
	say "sshd: macOS starts sshd for each connection, so a new connection reads the file. No reload is needed."
}

# Check the settings that sshd gives to one account. The check catches a file
# in /etc/ssh/sshd_config.d that sorts before ours and sets a keyword first.
verify_sshd() {
	local account="$1" expected="$2" out line
	[ -z "$DRY" ] || return 0
	out="$(sshd -T -C "user=$account,host=localhost,addr=127.0.0.1" 2>&1)" ||
		die "sshd -T failed for $account: $out"
	while read -r line; do
		printf '%s\n' "$out" | grep -qx "$line" ||
			die "sshd gives $account a setting other than '$line'. A file in /etc/ssh/sshd_config.d that sorts before 100-workbench.conf sets it first. Check: sudo sshd -T -C user=$account,host=localhost,addr=127.0.0.1"
	done <<EOF
$expected
EOF
}

verify_dropin() {
	verify_sshd "$SELF_ACCOUNT" "authenticationmethods publickey
passwordauthentication no
kbdinteractiveauthentication no
pubkeyauthentication yes
allowtcpforwarding yes
authorizedkeysfile .ssh/authorized_keys"
	verify_sshd "$GIT_ACCOUNT" "authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys.ambion"
}

# Remote Login that setup.sh turns on lets every user of this Mac log in,
# unless the group com.apple.access_ssh exists. In that case the script makes
# the group first, with the accounts of the workstation and the admin. The
# marker file tells teardown.sh that the script made the group.
limit_ssh_users() {
	local name
	group_exists "$SSH_GROUP" && return 0
	say "$SSH_GROUP: create it, with the accounts of the workstation and $ADMIN. Remote Login was off, so only these users can log in with ssh. teardown.sh removes the group."
	run dseditgroup -o create -q "$SSH_GROUP"
	run dscl . -create "/Groups/$SSH_GROUP" Comment "$MARK"
	while read -r name; do
		run dseditgroup -o edit -a "$name" -t user "$SSH_GROUP"
	done < <(all_accounts)
	run dseditgroup -o edit -a "$ADMIN" -t user "$SSH_GROUP"
	put 0644 root:wheel "$SSH_GROUP_MARKER" <<EOF
setup.sh made the group $SSH_GROUP.
EOF
}

enable_remote_login() {
	if [ "$(remote_login_state)" = on ] && { [ -n "$DRY" ] || sshd_listening; }; then
		say "Remote Login: on"
		return 0
	fi
	limit_ssh_users
	say "Remote Login: turn on"
	try systemsetup -f -setremotelogin on || true
	if [ -z "$DRY" ] && ! sshd_listening; then
		warn "systemsetup could not turn on Remote Login. It needs Full Disk Access for the terminal. Trying launchctl."
		try launchctl enable system/com.openssh.sshd || true
		try launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist || true
		sleep 1
	fi
	if [ -z "$DRY" ] && ! sshd_listening; then
		warn "Remote Login is still off. Open System Settings > General > Sharing, turn on Remote Login, and run this script again."
	fi
}

# When Remote Login limits the users, the group com.apple.access_ssh exists.
# The accounts of the workstation join it. Nobody leaves it.
allow_ssh_group() {
	local name
	group_exists "$SSH_GROUP" || return 0
	say "$SSH_GROUP: add the accounts"
	while read -r name; do
		add_to_group "$name" "$SSH_GROUP"
	done < <(all_accounts)
	is_member "$ADMIN" "$SSH_GROUP" ||
		warn "$ADMIN is not in $SSH_GROUP, so $ADMIN cannot log in with ssh. The script leaves the group as it is."
}

# The host key of this Mac is the host key of the workstation. macOS makes
# it when sshd runs for the first time, and sshd -t needs it before that.
# ssh-keygen -A makes each host key that is missing and keeps the others.
ensure_host_key() {
	[ -f "$HOST_KEY_PUB" ] || try ssh-keygen -A || true
	[ -f "$HOST_KEY_PUB" ] ||
		die "the host key $HOST_KEY_PUB does not exist. Set WORKBENCH_HOST_KEY_PUB to the path of the public key."
}

# The config of Workbench for this workstation, and a known_hosts file.
write_config() {
	local fingerprint roots="" name
	fingerprint="$(ssh-keygen -lf "$HOST_KEY_PUB" | cut -d' ' -f2)"
	for name in "${ROOT_NAMES[@]}"; do
		roots="$roots${roots:+, }\"/$name\""
	done
	echo "127.0.0.1 $(cut -d' ' -f1-2 "$HOST_KEY_PUB")" | as_admin tee "$STATE/macos.known_hosts" >/dev/null
	as_admin tee "$STATE/macos.json" >/dev/null <<JSON
{
	"host": "127.0.0.1",
	"port": 22,
	"hostKey": "$fingerprint",
	"keys": "keys",
	"gitAccount": "$GIT_ACCOUNT",
	"layout": {
		"audit": "$SHARE/srv/audit/audit.jsonl",
		"rooms": "$SHARE/srv/rooms",
		"snapshots": "$SHARE/srv/snapshots"
	},
	"roots": [$roots]
}
JSON
	say "workstation: $STATE/macos.json"
}

# The script that the self-check runs on the seat. It names each tool that
# the backend needs and the seat lacks.
backend_probe() {
	cat <<'SCRIPT'
missing=""
for tool in setsid flock; do command -v "$tool" >/dev/null || missing="$missing $tool"; done
date -d @0 +%s >/dev/null 2>&1 || missing="$missing GNU-date"
now="$(date +%s%3N 2>/dev/null)"
case "$now" in *[!0-9]* | "") missing="$missing GNU-date" ;; esac
stat -c %a / >/dev/null 2>&1 || missing="$missing GNU-stat"
echo x | base64 -w0 >/dev/null 2>&1 || missing="$missing GNU-base64"
git --version >/dev/null 2>&1 || missing="$missing git"
echo "backend-missing:$missing"
SCRIPT
}

# Log in as one seat with its key, the way the checks of a person do. Then run
# what the backend needs, in the same form that the backend uses.
self_check() {
	local ssh_args out
	ssh_args=(-i "$STATE/keys/$SELF_ACCOUNT" -o IdentitiesOnly=yes -o BatchMode=yes
		-o ConnectTimeout=5 -o "UserKnownHostsFile=$STATE/macos.known_hosts")
	if [ -n "$DRY" ]; then
		run ssh "${ssh_args[@]}" "$SELF_ACCOUNT@127.0.0.1" true
		return 0
	fi
	if ! out="$(as_admin ssh "${ssh_args[@]}" "$SELF_ACCOUNT@127.0.0.1" true 2>&1)"; then
		printf '%s\n' "$out" >&2
		die "the check login as $SELF_ACCOUNT failed. Look at 'sudo log show --last 2m --predicate \"process == \\\"sshd\\\"\"'."
	fi
	say "check: $SELF_ACCOUNT logs in with its key"
	out="$(as_admin ssh "${ssh_args[@]}" "$SELF_ACCOUNT@127.0.0.1" 'exec setsid --wait bash -s' \
		< <(backend_probe) 2>&1 || true)"
	case "$out" in
	*"backend-missing:") say "check: the backend tools work for $SELF_ACCOUNT" ;;
	*) warn "the backend tools fail for $SELF_ACCOUNT: $out" ;;
	esac
	if ! as_admin ssh "${ssh_args[@]}" "$SELF_ACCOUNT@127.0.0.1" \
		"python3 -c 'import sys; sys.exit(2) if sys.version_info[:2] < tuple(map(int, sys.argv[1].split(\".\"))) else None; import serial, numpy, PIL' $PYTHON_FLOOR" \
		>/dev/null 2>&1; then
		warn "python3 $PYTHON_FLOOR or newer, with pyserial, numpy, and pillow, is not on the PATH of $SELF_ACCOUNT. The templates need it. The script installs no package. Run as $ADMIN: brew install python coreutils ffmpeg && python3 -m pip install --break-system-packages pyserial numpy pillow"
	fi
}

check_platform
preflight
check_ids
check_root_names
check_layout
check_homes
record_state
make_keys
make_accounts
make_layout
install_shims
ensure_host_key
write_dropin
enable_remote_login
allow_ssh_group
write_config
verify_dropin
make_root_links
self_check

say ""
say "The workstation is ready. Start Workbench on it:"
say "  make mac-workbench"
