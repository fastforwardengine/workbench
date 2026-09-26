#!/usr/bin/env bash
# Write the keys of a local workstation, on the machine that runs Workbench:
#
#   bash workstation/setup.sh [state-dir]     # .workstation by default
#
# The script makes one Ed25519 key for each account of workstation/accounts
# and for the git account, and the host key of the workstation. It keeps a
# key that exists, so the container and Workbench keep working after a second
# run. It writes <state-dir>/workstation.json, which WORKBENCH_WORKSTATION
# names. The state directory holds private keys: git ignores .workstation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${1:-$HERE/../.workstation}"
PORT=2222
GIT_ACCOUNT=workbench-git
# macOS has bash 3.2, which has no mapfile.
ACCOUNTS=()
while read -r name; do ACCOUNTS+=("$name"); done < <(grep -v "^#" "$HERE/accounts")

mkdir -p "$STATE/keys"
chmod 0700 "$STATE" "$STATE/keys"

for name in "${ACCOUNTS[@]}" "$GIT_ACCOUNT"; do
	[ -f "$STATE/keys/$name" ] || ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$STATE/keys/$name"
done
[ -f "$STATE/ssh_host_ed25519_key" ] ||
	ssh-keygen -q -t ed25519 -N '' -C workbench-workstation -f "$STATE/ssh_host_ed25519_key"

fingerprint="$(ssh-keygen -lf "$STATE/ssh_host_ed25519_key.pub" | cut -d' ' -f2)"
# A known_hosts file for a person who logs in with ssh, such as:
#   ssh -p 2222 -i .workstation/keys/experiments -o UserKnownHostsFile=.workstation/known_hosts experiments@127.0.0.1
echo "[127.0.0.1]:$PORT $(cut -d' ' -f1-2 "$STATE/ssh_host_ed25519_key.pub")" >"$STATE/known_hosts"
cat >"$STATE/workstation.json" <<JSON
{
	"host": "127.0.0.1",
	"port": $PORT,
	"hostKey": "$fingerprint",
	"keys": "keys",
	"gitAccount": "$GIT_ACCOUNT",
	"layout": { "audit": "/srv/workbench/audit/audit.jsonl", "rooms": "/srv/workbench/rooms" },
	"roots": ["/library", "/shared"]
}
JSON
echo "workstation: $(cd "$STATE" && pwd)/workstation.json"
