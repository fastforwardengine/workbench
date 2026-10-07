#!/usr/bin/env bash
# Remove the workstation that setup.sh made on this Mac:
#
#   sudo bash workstation/macos/teardown.sh [--yes] [state-dir]
#
# The script asks once, and then it removes the sshd drop-in, the accounts
# with their homes, the group, the root links of /etc/synthetic.conf, and
# the shims. It puts Remote Login back to the state that it had before
# setup.sh. A second question asks about /Users/Shared/workbench, which holds
# the notes and the snapshots. --yes answers both questions.
#
# The script leaves the account and the files of the admin alone. It leaves the
# keys in the state folder, because the container uses them too. It deletes
# only an account or a group that carries the comment of setup.sh. A second
# run finds nothing to do.
#
# WORKBENCH_DRY_RUN=1 prints each privileged command and writes nothing.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ASSUME_YES=""
STATE=""
for argument in "$@"; do
	case "$argument" in
	--yes | -y) ASSUME_YES=1 ;;
	--help | -h)
		sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	-*) die "unknown option $argument. Use --yes or --help." ;;
	*) STATE="$argument" ;;
	esac
done
STATE="${STATE:-$REPO/.workstation}"

# The accounts of this workstation that carry our comment, as a list with a
# space around each name. An account of the same name with another comment stays.
USERS_FOUND=" "
HAS_GROUP=""
HAS_DROPIN=""
HAS_LINKS=""
HAS_LIBEXEC=""
HAS_SHARE=""
HAS_CONFIG=""

# One question. --yes answers it. An answer other than "yes" means no.
confirm() {
	local answer=""
	[ -z "$ASSUME_YES" ] || return 0
	printf '%s Type yes: ' "$1"
	read -r answer || true
	[ -t 0 ] || printf '\n'
	[ "$answer" = yes ]
}

# True when a line that setup.sh added is in /etc/synthetic.conf.
links_present() {
	local name
	[ -f "$SYNTHETIC" ] || return 1
	for name in "${ROOT_NAMES[@]}"; do
		grep -qxF "$(synthetic_line "$name")" "$SYNTHETIC" && return 0
	done
	return 1
}

survey() {
	local name
	while read -r name; do
		if [ -z "$(user_uid "$name")" ]; then
			continue
		elif user_marked "$name"; then
			USERS_FOUND="$USERS_FOUND$name "
		else
			warn "the user $name exists, and setup.sh did not make it. The script leaves it."
		fi
	done < <(all_accounts)
	if group_exists "$GROUP"; then
		if group_marked "$GROUP"; then
			HAS_GROUP=1
		else
			warn "the group $GROUP exists, and setup.sh did not make it. The script leaves it."
		fi
	fi
	[ ! -f "$SSHD_DROPIN" ] || HAS_DROPIN=1
	if links_present; then HAS_LINKS=1; fi
	[ ! -d "$LIBEXEC" ] || HAS_LIBEXEC=1
	[ ! -e "$SHARE" ] || HAS_SHARE=1
	if [ -f "$STATE/macos.json" ] || [ -f "$STATE/macos.known_hosts" ]; then HAS_CONFIG=1; fi
}

plan() {
	say "This removes the workstation of this Mac:"
	[ -z "$HAS_DROPIN" ] || say "  the sshd drop-in $SSHD_DROPIN"
	[ "$USERS_FOUND" = " " ] || say "  the users:${USERS_FOUND% }, with their homes"
	[ -z "$HAS_GROUP" ] || say "  the group $GROUP"
	[ -z "$HAS_LINKS" ] || say "  the root links of $SYNTHETIC (the lines that setup.sh added)"
	[ -z "$HAS_LIBEXEC" ] || say "  the shims and the state in $LIBEXEC"
	[ -z "$HAS_CONFIG" ] || say "  $STATE/macos.json and macos.known_hosts"
	[ -z "$HAS_SHARE" ] || say "  $SHARE, after a second question"
	say "It keeps your own account and files, the keys in $STATE, and the container."
}

# Remote Login goes back to its state before setup.sh. An unknown state stays.
restore_remote_login() {
	local before=""
	[ -f "$STATE_FILE" ] && before="$(sed -n 's/^remotelogin=//p' "$STATE_FILE")"
	if [ "$before" != off ]; then
		say "Remote Login: leave as it is (before setup: ${before:-unknown})"
		return 0
	fi
	if [ "$(remote_login_state)" = off ]; then
		say "Remote Login: off"
		return 0
	fi
	say "Remote Login: turn off, as before setup"
	try systemsetup -f -setremotelogin off || true
	if [ -z "$DRY" ] && sshd_listening; then
		try launchctl disable system/com.openssh.sshd || true
		try launchctl bootout system/com.openssh.sshd || true
	fi
	if [ -z "$DRY" ] && sshd_listening; then
		warn "Remote Login is still on. Turn it off in System Settings > General > Sharing."
	fi
}

remove_dropin() {
	[ -n "$HAS_DROPIN" ] || return 0
	run rm -f "$SSHD_DROPIN"
	say "sshd: macOS starts sshd for each connection, so a new connection reads the change. No reload is needed."
}

# Delete one user: stop its processes, delete the record and the home. The
# folder of a home is under $HOMES and carries the name of the account.
delete_user() {
	local name="$1" uid home="$HOMES/$1"
	uid="$(user_uid "$name")"
	say "account $name: delete"
	if [ -n "$SSH_GROUP_EXISTS" ] && is_member "$name" "$SSH_GROUP"; then
		run dseditgroup -o edit -d "$name" -t user "$SSH_GROUP"
	fi
	try pkill -KILL -u "$uid" || true
	try sysadminctl -deleteUser "$name" || true
	if [ -z "$DRY" ]; then
		[ -z "$(user_uid "$name")" ] || run dscl . -delete "/Users/$name"
		[ ! -d "$home" ] || run rm -rf "$home"
	fi
}

remove_users() {
	local name
	SSH_GROUP_EXISTS=""
	if group_exists "$SSH_GROUP"; then SSH_GROUP_EXISTS=1; fi
	for name in $USERS_FOUND; do
		delete_user "$name"
	done
}

remove_group() {
	[ -n "$HAS_GROUP" ] || return 0
	say "group $GROUP: delete"
	run dseditgroup -o delete "$GROUP"
}

# Remove the lines that setup.sh added. Every other line stays. A reboot
# clears the links in `/`.
remove_links() {
	local ours rest name
	[ -n "$HAS_LINKS" ] || return 0
	ours="$(for name in "${ROOT_NAMES[@]}"; do synthetic_line "$name"; done)"
	rest="$(grep -vxF -f <(printf '%s\n' "$ours") "$SYNTHETIC" || true)"
	if [ -z "$(printf '%s' "$rest" | tr -d '[:space:]')" ]; then
		run rm -f "$SYNTHETIC"
	else
		printf '%s\n' "$rest" | put 0644 root:wheel "$SYNTHETIC"
	fi
	say "root links: removed from $SYNTHETIC. The links in / stay until the next restart."
}

remove_libexec() {
	[ -n "$HAS_LIBEXEC" ] || return 0
	restore_remote_login
	case "$LIBEXEC" in
	*/workbench) run rm -rf "$LIBEXEC" ;;
	*) die "$LIBEXEC does not end in /workbench. The script does not remove it." ;;
	esac
}

remove_config() {
	[ -n "$HAS_CONFIG" ] || return 0
	run as_admin rm -f "$STATE/macos.json" "$STATE/macos.known_hosts"
}

# The data folder holds the notes, the audit log, and the snapshots. It has a
# question of its own.
remove_share() {
	[ -n "$HAS_SHARE" ] || return 0
	case "$SHARE" in
	"" | / | /Users | /Users/Shared | /Users/Shared/) die "$SHARE is not a folder that the script removes." ;;
	esac
	if confirm "Remove $SHARE with the notes, the audit log, and the snapshots? This cannot be undone."; then
		run rm -rf "$SHARE"
	else
		say "$SHARE: kept"
	fi
}

check_platform
survey
if [ -z "$HAS_DROPIN$HAS_GROUP$HAS_LINKS$HAS_LIBEXEC$HAS_SHARE$HAS_CONFIG" ] && [ "$USERS_FOUND" = " " ]; then
	say "Nothing to do: this Mac holds no workstation of Workbench."
	exit 0
fi
plan
if ! confirm "Continue?"; then
	say "Nothing removed."
	exit 1
fi
remove_dropin
remove_users
remove_group
remove_links
remove_libexec
remove_config
remove_share
say "Done."
