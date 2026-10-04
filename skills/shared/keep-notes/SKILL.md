---
name: keep-notes
description: Read, add to, or dispute the notes of the team, the shared git repository shared/notes. Use it when you learn a fact, settle a question, or disagree with a claim of another seat.
---

The notes are the memory of the team. Read `README.md` in the notes for the
layout, the form of a claim, and the stewards.

1. Run the macro `keep-notes/pull`: `compose({ macro: 'keep-notes/pull' })`.
   It clones `shared/notes` into `~/notes` when the clone is absent, sets
   your git identity, and pulls. It returns `head`, the last 5 commits with
   their files in `log`, and the open `disputes`.
2. Read `README.md` in the notes and the files of the folder for your task.
3. Read each open dispute on the topic of your task before you act on it.
4. Add a claim to the file of its subject, in the form that `README.md`
   gives for a claim, with its source and its confidence.
5. Run the macro `keep-notes/push` with a message of the form
   `<folder>: <what and why>`:
   `compose({ macro: 'keep-notes/push', args: { message } })`. It commits
   all changes in `~/notes`, and pushes to `origin main`. If the push is
   rejected, it pulls once and pushes again. After a conflict it aborts the
   rebase and fails. Then fix the conflict by hand in `~/notes` with
   `git pull --rebase`, keep both edits, and run the macro again.
6. To disagree with a claim of another seat, do not edit it. Make a branch
   `dispute/<topic>`, add your own claim and the evidence, name the claim you
   dispute by its file, and push the branch: `git push origin dispute/<topic>`.
   Never rewrite or delete a dispute branch.
7. Cite the `commit` that the macro returns in `refs` of the message that relies on the note, in the
   form that the git guidance gives.
