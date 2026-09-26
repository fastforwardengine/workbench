# Templates and the git backend

**The workspace has a git server, and the host registers the templates of
this repository on it.** An agent forks a template, clones the fork into
its home, edits it, commits, and pushes a branch. A push keeps the work
across a restart of the host. Ambion's
[git backend page](https://github.com/ambionframework/ambion/blob/main/docs/git.md)
holds the contract, the tools, and the credentials.

## Where each part lives

| Part                 | Where                      | What it holds                                          |
| -------------------- | -------------------------- | ------------------------------------------------------ |
| The files            | `templates/<name>/`        | The files that a fork starts with, text only           |
| The registry         | `src/domain/templates.ts`  | The name, description, use, and specialists of each    |
| The git backend      | `src/host/repositories.ts` | `labRepositories`, which registers every template      |
| The wiring           | `src/host/rooms.ts`        | The `git` backend of the workspace, in `<data>/git.db` |
| The registry check   | `test/templates.test.ts`   | The check of directories to entries                    |
| The flow of an agent | `test/tool-set.test.ts`    | A scripted seat forks `test-plan` and pushes a branch  |

**The host runs the git server in its own process.** The bash backend is
the local just-bash directory under `<data>/workspace`, and its `git`
reaches the server in process. No network takes part.

## Add a template

1. Make a directory `templates/<name>/`. The name matches
   `^[a-z0-9][a-z0-9._-]{0,63}$`.
2. Add a `README.md` with the numbered steps an agent follows. End with
   "Commit, and push your branch. A push keeps the work."
3. Add the other files. Mark each value the agent fills in with `TBD`.
4. Add an entry to `templates` in `src/domain/templates.ts`. The
   `description` shows in `repos`. The `use` is a noun phrase, such as "a
   test plan". The `specialists` get one instruction line that names the
   template.

## Change a template

**Edit the files in place.** At the next start, the host registers the
new files. The git backend moves `templates/<name>` to a new commit whose
parent is the old tip. A changed `description` replaces the old one.

**A fork keeps the commit it came from.** A room that works on a fork does
not see the change. A new fork starts from the new commit.

**No tool rewrites a template.** `.prettierignore` holds `templates/`.
`templateFiles` skips `.git`, `.DS_Store`, and `__pycache__`, so a file
that a tool writes beside a template does not change it.

## The templates today

| Template      | Use                                | Specialists |
| ------------- | ---------------------------------- | ----------- |
| `test-plan`   | A test plan                        | Experiments |
| `device-scan` | A scan of the connected devices    | Instruments |
| `hm310p`      | Control of the HM310P power supply | Instruments |

`planning/next.md` names the next one: an LED parameter sweep.
