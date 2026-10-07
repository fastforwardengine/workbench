# shellcheck shell=bash disable=SC2034
# The words and the helpers that setup.sh and teardown.sh share. Source this
# file. Do not run it. The scripts run on the bash 3.2 of macOS: no mapfile,
# no associative array, and no empty array under `set -u`.
#
# WORKBENCH_DRY_RUN=1 prints each privileged command and each file it would
# write, and skips the checks for Darwin and for root. The test in
# test/workstation-macos.test.ts uses it on Linux. The WORKBENCH_* paths below
# have a default for a Mac. The test sets them to paths in a temporary folder.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

DRY="${WORKBENCH_DRY_RUN:-}"
[ "$DRY" = 1 ] || DRY=""

# The accounts. The file workstation/accounts lists the group accounts. The
# git account is outside the group, as in the container.
ACCOUNTS=()
while read -r name; do ACCOUNTS+=("$name"); done < <(grep -Ev '^[[:space:]]*(#|$)' "$REPO/workstation/accounts")
GIT_ACCOUNT=workbench-git
GROUP=workbench
# The comment of each record that setup.sh makes. teardown.sh deletes only
# a record with this comment, so it never deletes an account that an admin made.
MARK=workbench-macos
# The fixed ids. The group accounts count up from UID_BASE in the order of
# the accounts file, and the git account has GIT_UID. macOS gives its own
# users 501 and up, and its service accounts less than 500.
UID_BASE="${WORKBENCH_UID_BASE:-5000}"
GIT_UID=$((UID_BASE + 900))
GROUP_GID="${WORKBENCH_GID:-5000}"
# The primary group of the git account. The group has no member and no file
# of its own, so it grants nothing. A group of the Mac, such as staff, would
# grant the account the files that the admin shares with staff. The group
# carries the same comment as the group of the seats.
GIT_GROUP=workbench-git
GIT_GID=$((GROUP_GID + 900))
ACCOUNT_SHELL=/bin/zsh

# The primary group of an account: the group of the seats, or for the git
# account its own group.
primary_group() {
	if [ "$1" = "$GIT_ACCOUNT" ]; then echo "$GIT_GROUP"; else echo "$GROUP"; fi
}

# The primary group id of an account.
primary_gid() {
	if [ "$1" = "$GIT_ACCOUNT" ]; then echo "$GIT_GID"; else echo "$GROUP_GID"; fi
}

# The host account writes the room mirror, the snapshots, and the datasheets.
HOST_ACCOUNT=""
for name in "${ACCOUNTS[@]}"; do
	case "$name" in *-host) HOST_ACCOUNT="$name" ;; esac
done

# The paths. The root folders of the workspace are links in `/`.
HOMES="${WORKBENCH_HOMES:-/Users}"
SHARE="${WORKBENCH_SHARE:-/Users/Shared/workbench}"
ROOT_DIR="${WORKBENCH_ROOT_DIR:-}"
ROOT_NAMES=(datasheets shared attachments)
LIBEXEC="${WORKBENCH_LIBEXEC:-/usr/local/libexec/workbench}"
SSHD_CONFIG="${WORKBENCH_SSHD_CONFIG:-/etc/ssh/sshd_config}"
SSHD_DROPIN="${WORKBENCH_SSHD_DROPIN:-/etc/ssh/sshd_config.d/100-workbench.conf}"
SYNTHETIC="${WORKBENCH_SYNTHETIC:-/etc/synthetic.conf}"
HOST_KEY_PUB="${WORKBENCH_HOST_KEY_PUB:-/etc/ssh/ssh_host_ed25519_key.pub}"
STATE_FILE="$LIBEXEC/state"
APFS_UTIL=/System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util
SSH_GROUP=com.apple.access_ssh
# setup.sh writes this file when it creates the group SSH_GROUP itself.
SSH_GROUP_MARKER="$LIBEXEC/ssh-group-created"
# The owner of a folder that only root may own. A dry run runs as a normal
# user, so it expects the current user. The test sets WORKBENCH_ROOT_UID.
ROOT_UID=0
[ -z "$DRY" ] || ROOT_UID="${WORKBENCH_ROOT_UID:-$(id -u)}"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

# Run one privileged command. A dry run prints it.
run() {
	if [ -n "$DRY" ]; then
		printf '+'
		printf ' %q' "$@"
		printf '\n'
	else
		"$@"
	fi
}

# Run one command that may fail, with no output. A dry run prints it.
try() {
	if [ -n "$DRY" ]; then
		run "$@"
	else
		"$@" >/dev/null 2>&1
	fi
}

# Write a file from the standard input: put MODE OWNER:GROUP PATH. A dry run
# prints the content, each line after "| ", between two "+" lines.
put() {
	local mode="$1" owner="$2" dest="$3" temp
	temp="$(mktemp)"
	cat >"$temp"
	if [ -n "$DRY" ]; then
		printf '+ write %s mode=%s owner=%s\n' "$dest" "$mode" "$owner"
		sed 's/^/| /' "$temp"
		printf '+ end %s\n' "$dest"
	else
		install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$temp" "$dest"
	fi
	rm -f "$temp"
}

# Write a file as a seat: put_seat NAME MODE PATH. A seat
# controls its own home, and root must not follow a link that the seat
# planted. The file goes to a temporary name and replaces the target with
# `mv`, which does not follow a link at the target. A dry run prints it like put.
put_seat() {
	local name="$1" mode="$2" dest="$3" temp
	temp="$(mktemp)"
	cat >"$temp"
	if [ -n "$DRY" ]; then
		printf '+ write %s mode=%s owner=%s:%s\n' "$dest" "$mode" "$name" "$(primary_group "$name")"
		sed 's/^/| /' "$temp"
		printf '+ end %s\n' "$dest"
	else
		# shellcheck disable=SC2024
		(cd / && sudo -n -u "$name" -H sh -c \
			'umask 077; cat >"$1.tmp.$$" && chmod "$2" "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"' \
			sh "$dest" "$mode" <"$temp") || {
			rm -f "$temp"
			die "could not write $dest as $name."
		}
	fi
	rm -f "$temp"
}

# Run a command as the admin who ran sudo, so a file in the state folder
# belongs to that admin. A dry run runs as the current user.
as_admin() {
	if [ -n "$DRY" ]; then
		"$@"
	else
		sudo -n -u "$ADMIN" -H "$@"
	fi
}

# Find the admin, and check the platform. A dry run skips the checks.
check_platform() {
	if [ -n "$DRY" ]; then
		ADMIN="${SUDO_USER:-$(id -un)}"
		return 0
	fi
	[ "$(uname -s)" = Darwin ] || die "this script runs on macOS only."
	[ "$(id -u)" = 0 ] || die "run this script with sudo: sudo bash $0"
	ADMIN="${SUDO_USER:-}"
	{ [ -n "$ADMIN" ] && [ "$ADMIN" != root ]; } ||
		die "run this script with sudo from an admin account. A root shell has no SUDO_USER."
}

# The id of a user, or nothing when the user has no id.
user_uid() {
	dscl . -read "/Users/$1" UniqueID 2>/dev/null | awk '{ print $2 }' || true
}

# True when a record of the user exists, also a record that setup.sh left
# half made, with no id.
user_exists() {
	dscl . -read "/Users/$1" >/dev/null 2>&1
}

# True when the user record carries our comment.
user_marked() {
	dscl . -read "/Users/$1" Comment 2>/dev/null | tr '\n' ' ' | grep -q "$MARK"
}

group_exists() {
	dscl . -read "/Groups/$1" >/dev/null 2>&1
}

group_marked() {
	dscl . -read "/Groups/$1" Comment 2>/dev/null | tr '\n' ' ' | grep -q "$MARK"
}

# True when the user is a member of the group.
is_member() {
	dseditgroup -o checkmember -m "$1" "$2" 2>/dev/null | grep -q '^yes'
}

# The names of the accounts, the group accounts first, then the git account.
all_accounts() {
	printf '%s\n' "${ACCOUNTS[@]}" "$GIT_ACCOUNT"
}

# The line of /etc/synthetic.conf for one root folder: a name, a tab, and the
# target, which is relative to `/`.
synthetic_line() {
	printf '%s\t%s\n' "$1" "${SHARE#/}/$1"
}

# The state of Remote Login: on or off. When no tool gives the state, the
# answer is whether sshd listens on the loopback address.
remote_login_state() {
	local out
	out="$(systemsetup -getremotelogin 2>/dev/null || true)"
	case "$out" in
	*": On"*) echo on; return 0 ;;
	*": Off"*) echo off; return 0 ;;
	esac
	out="$(launchctl print-disabled system 2>/dev/null | grep 'com.openssh.sshd' || true)"
	case "$out" in
	*disabled* | *true*) echo off ;;
	*enabled* | *false*) echo on ;;
	*)
		if sshd_listening; then echo on; else echo off; fi
		;;
	esac
}

# True when something listens on port 22 of the loopback address.
sshd_listening() {
	nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1
}
