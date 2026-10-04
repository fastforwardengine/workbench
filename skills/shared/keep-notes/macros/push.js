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
	tools.bash({ command: `cd ~/notes && ${command}`, wait }).catch((error) => error.details);
const ok = (run) => run.process.state === 'exited' && run.process.exitCode === 0;
const head = async () => (await ran('git rev-parse HEAD', 30)).text.trim();
const commit = await ran(`git add -A && git commit -m ${quote(message)}`, 30);
if (!ok(commit)) {
	const status = await ran('git status --porcelain', 30);
	if (ok(status) && status.text.trim() === '') {
		return {
			commit: await head(),
			repository: 'shared/notes',
			committed: false,
			note: 'Nothing to commit.',
		};
	}
	throw new Error(`The commit failed: ${commit.text}`);
}
let push = await ran('git push origin main', 60);
if (!ok(push)) {
	const pull = await ran('git pull --rebase', 60);
	if (!ok(pull)) {
		await ran('git rebase --abort', 30);
		throw new Error(
			`The pull found a conflict, and the rebase is aborted. Resolve it by hand, as step 5 of the skill says: ${pull.text}`,
		);
	}
	push = await ran('git push origin main', 60);
	if (!ok(push)) throw new Error(`The push failed: ${push.text}`);
}
return { commit: await head(), repository: 'shared/notes', committed: true };
