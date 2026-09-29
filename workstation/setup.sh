#!/usr/bin/env bash
# Write the keys of a local workstation, on the machine that runs Workbench:
#
#   bash workstation/setup.sh [state-dir]     # .workstation by default
#
# The script makes one Ed25519 key for each account of workstation/accounts
# and for the git account, and the host key of the workstation. It keeps a
# key that exists, so the container and Workbench keep working after a second
# run. It writes <state-dir>/workstation.json, which WORKBENCH_WORKSTATION
# names. It also writes <state-dir>/objects.env, the credentials of the object
# store, and keeps them on a second run. The state directory holds private keys
# and credentials: git ignores .workstation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${1:-$HERE/../.workstation}"
PORT=2222
GIT_ACCOUNT=workbench-git
# The object store: a bucket on the silo container, and the S3 API on this port.
OBJECTS_PORT=9000
OBJECTS_BUCKET=workbench-snapshots
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

# The credentials of the object store. The server and the init job read the
# root pair. Workbench reads the second pair, which the init job limits to the
# bucket. compose.yaml passes the file to both containers with env_file.
if [ ! -f "$STATE/objects.env" ]; then
	(
		umask 077
		cat >"$STATE/objects.env" <<ENV
MINIO_ROOT_USER=workbench-root
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
S3_ACCESS_KEY_ID=workbench-host
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)
ENV
	)
fi
chmod 0600 "$STATE/objects.env"

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
	"layout": {
		"audit": "/srv/workbench/audit/audit.jsonl",
		"rooms": "/srv/workbench/rooms",
		"snapshots": "/srv/workbench/snapshots"
	},
	"objects": {
		"endpoint": "http://127.0.0.1:$OBJECTS_PORT",
		"region": "us-east-1",
		"bucket": "$OBJECTS_BUCKET",
		"prefix": "workbench/",
		"credentials": "objects.env"
	},
	"roots": ["/library", "/shared"]
}
JSON
echo "workstation: $(cd "$STATE" && pwd)/workstation.json"
