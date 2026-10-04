/*---
description: Get ~/notes up to date. Clone it on the first call, set your git identity, and pull. Returns the head commit, the last 5 commits with their files, and the open disputes.
uses: [repos, bash]
args:
  type: object
  properties: {}
  additionalProperties: false
---*/
const listed = await tools.repos({});
const notes = listed.repositories.find((repo) => repo.id === 'shared/notes');
if (!notes) throw new Error('The git server holds no shared/notes.');
const script = [
	'set -e',
	`test -d ~/notes/.git || git clone '${notes.url}' ~/notes`,
	'cd ~/notes',
	'name=$(basename "$HOME")',
	'git config user.name "$name"',
	'git config user.email "$name@ambion.invalid"',
	'git pull --rebase',
	'git fetch',
	'echo "@@head"',
	'git rev-parse HEAD',
	'echo "@@log"',
	'git log -n 5 --name-only',
	'echo "@@disputes"',
	'for b in $(git branch -r | grep -o "origin/dispute/[^ ]*" || true); do',
	'  test -n "$(git log --oneline origin/main..$b)" && echo "$b"',
	'done',
	'echo "@@end"',
].join('\n');
const run = await tools.bash({ command: script, wait: 60 });
const result = { head: '', log: [], disputes: [] };
let section = '';
for (const line of run.text.split('\n')) {
	if (line.startsWith('@@')) section = line.slice(2);
	else if (line.trim() === '') continue;
	else if (section === 'head') result.head = line.trim();
	else if (section === 'disputes') result.disputes.push(line.trim());
	else if (section === 'log' && line.startsWith('commit ')) {
		result.log.push({ commit: line.slice(7).trim(), subject: '', files: [] });
	} else if (section === 'log') {
		const entry = result.log[result.log.length - 1];
		if (/^(Author|Date|Merge):/.test(line)) continue;
		if (line.startsWith('    ')) entry.subject ||= line.trim();
		else entry.files.push(line.trim());
	}
}
return result;
