/*---
description: Stage all changes in ~/notes, commit them, and push to origin main. Pull once and push again when the push is rejected. Returns the full hash of the commit to cite.
uses: [bash]
args:
  type: object
  properties:
    message:
      type: string
      description: "The commit message, in the form <folder>: <what and why>."
  required: [message]
  additionalProperties: false
---*/
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const message = String(args.message ?? '').trim();
if (message === '') throw new Error('Give a message of the form <folder>: <what and why>.');
const ran = (command, wait) =>
	tools
		.bash({ command: `cd ~/notes && ${command}`, wait })
		.catch((error) => error.details ?? { text: String(error.message), process: {} });
const ok = (run) => run.process.state === 'exited' && run.process.exitCode === 0;
const text = async (command) => (await ran(command, 30)).text.trim();
const rebasing = async () =>
	(await text('if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then echo yes; fi')) ===
	'yes';
if (await rebasing()) {
	throw new Error(
		'A rebase is in progress in ~/notes. Resolve the conflict, run git add on the files and git rebase --continue, then run this macro again.',
	);
}
const commit = await ran(`git add -A && git commit -m ${quote(message)}`, 30);
let committed = true;
if (!ok(commit)) {
	if ((await text('git status --porcelain')) !== '') {
		throw new Error(`The commit failed: ${commit.text}`);
	}
	committed = false;
}
let push = await ran('git push origin main', 60);
if (!ok(push)) {
	const pull = await ran('git pull --rebase', 60);
	if (!ok(pull)) {
		const conflict = (await rebasing()) || pull.text.includes('CONFLICT');
		if (await rebasing()) await ran('git rebase --abort', 30);
		throw new Error(
			conflict
				? `The pull found a conflict, and the rebase is aborted. Resolve it by hand, as step 5 of the skill says: ${pull.text}`
				: `The pull failed: ${pull.text}`,
		);
	}
	push = await ran('git push origin main', 60);
	if (!ok(push)) throw new Error(`The push failed: ${push.text}`);
}
await ran('git fetch', 60);
const head = await text('git rev-parse HEAD');
if (head !== (await text('git rev-parse origin/main'))) {
	throw new Error('After the push, HEAD differs from origin/main.');
}
const result = { commit: head, repository: 'shared/notes', committed };
if (!committed) result.note = 'Nothing new to commit.';
return result;
