---
name: keep-notes
description: Read, add to, or dispute the notes of the team, the shared git repository shared/notes. Use it when you learn a fact, settle a question, or disagree with a claim of another seat.
---

The notes are the memory of the team. Read `README.md` in the notes for the
layout, the form of a claim, and the stewards.

1. Get a working copy. If `~/notes` does not exist, run `clone` with source
   `shared/notes` and path `~/notes`. Then run
   `git config user.name <your name>` and
   `git config user.email <your name>@ambion.invalid` in it.
2. Pull before you act: `cd ~/notes && git pull --rebase`. Read `README.md`
   and the files of the folder for your task. To see what changed since your
   last look, run `git log --stat -5`.
3. List the open disputes: `git fetch`, then `git branch -r`. A branch
   `origin/dispute/<topic>` is open when `git log origin/main..origin/dispute/<topic>`
   prints commits. Read an open dispute before you act on its topic.
4. Add a claim to the file of its subject, as one bullet:
   `- **The statement.** Source: <where it comes from>. Confidence: high|medium|low.`
   The source is a `library/` path, a snapshot ref, a commit ref, or a
   message ref. A reading counts only when a script wrote it to a file and you
   snapshotted the file. Every other value is a planned value, and the claim
   says so.
5. Commit with a message of the form `<folder>: <what and why>`, then push:
   `git push origin main`. If the push is rejected, run
   `git pull --rebase`, fix any conflict by keeping both edits, and push
   again.
6. To disagree with a claim of another seat, do not edit it. Make a branch
   `dispute/<topic>`, add your own claim and the evidence, name the claim you
   dispute by its file, and push the branch: `git push origin dispute/<topic>`.
   Never rewrite or delete a dispute branch.
7. Cite the commit in `refs` of the message that relies on the note, in the
   form that the git guidance gives.
