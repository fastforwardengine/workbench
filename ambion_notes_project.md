# Project: shared git repositories in Ambion

**This page briefs one change to Ambion: a repository that every agent of a
workspace can push to.** Workbench needs it for its team notes
([`docs/notes.md`](docs/notes.md)). The change is small in code and reverses
one design decision. The page states the finding, the design, the work, and
the questions that the owner of Ambion decides.

- **Reviewed:** the `ambion` checkout next to this repository, at commit
  `5846ef9e`, which equals `origin/main`, on 2026-09-29. The 0.5.0 scope is
  the sensor lifecycle. This change is not in it.
- **Status:** a proposal. No code exists.
- **Rule for the code:** Ambion promises no compatibility before 1.0.0. The
  change adds no alias and no migration, and the changelog names it.

## The need

**Workbench wants one place where all specialists keep what they conclude.**
Each specialist reads and writes it, and a disagreement stays visible until
evidence settles it. Git gives the pieces: an author and a time for each
change, a rejected push for a lost race, and a branch for a dispute. Today
the team keeps this state in Markdown files that it rewrites as a whole, so
two seats that write at once lose one edit.

## What the review found

**The git backend has one pusher for each repository, by decision.** The
page `docs/git.md` of Ambion states it under "Decisions taken": "One agent
pushes to a repository: its owner. A peer reads the repository and forks
it. Two agents work on one task through two forks." A shared repository
reverses that decision for one namespace.

**The rule lives in these places.** A change touches each of them.

| Place                                                     | What it does today                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/workspace/src/git-names.ts` (13, 37, 47)        | `TEMPLATES` is the one reserved name. `assertAgent` refuses it. `readOnly` marks a template               |
| `packages/just-bash/src/git/backend.ts` (145)             | `scope` is `write` when the namespace of the repository equals the agent name, and `read` otherwise       |
| `packages/just-bash/src/git/server.ts` (73 to 81)         | `preReceive` refuses a push to a template, and a push with a read token                                   |
| `packages/workstation/src/git-prepare.ts` (47)            | The `serve` script refuses `git-receive-pack` when `$namespace` differs from `$agent`                     |
| `packages/workspace/src/git-tools.ts` (66 to 70, 81, 117) | The guidance and the `repos` text: "You push only to `<your name>/<name>`"                                |
| `packages/just-bash/src/git/registration.ts`              | Registration creates and updates templates. Nothing else creates a repository except `fork`               |
| `packages/workstation/src/git-registration.ts`            | The same, with a staging folder and one rename                                                            |
| `packages/workspace/src/sensors.ts` (19 to 22)            | The sensor source pattern `^(?!templates/)…` calls the rest "an agent-owned Git repository"               |
| Conformance plumbing                                      | `GitConformanceOptions` (`git-conformance.ts`, 37 to 42) has `templates` alone; the two harnesses pass it |
| The docs and the comments                                 | See the list below                                                                                        |

**Docs and comments that state the rule.** `docs/git.md` (65, 71, 232,
330, 534, 564, 793), `docs/workstation-git.md` (266, 276, 574),
`docs/trust.md` (62), `packages/just-bash/README.md` (68), and the header
comments of `git-names.ts`, `backend.ts`, and `server.ts`.

**Ambion has the tools for a shared repository already.**

- `fork` accepts any readable repository as its source, so an agent can fork
  a shared repository.
- `clone` gives a working copy whose `origin` keeps the push rights of the
  source. A seat uses `clone` for a shared repository.
- The commit ref form (`ambion://workspace/<workspace>/repo/<repository>/…`)
  holds any ID of the form `<namespace>/<name>`, so `shared/notes` needs no
  change there.
- `just-git` 1.8.2 has what the server needs. `ServerPolicy` holds
  `protectedBranches`, `denyNonFastForward`, and `denyDeletes`, all
  server-wide (`dist/server/index.d.ts`, lines 298 to 302). The hooks hold
  `update` for a rule on one ref, and `postReceive` (lines 644 to 654).
- The server orders pushes. Each ref update compares the old commit, and a
  push that lost the race fails. Two seats that push to one branch
  therefore rebase and push again.

**Two facts differ between the backends.**

- **The author.** The just-bash `git` locks the author of a commit to the
  agent. On the workstation, `serve` sets only the committer, and that
  reaches the reflog alone. The seat sets its own author, or its commit
  fails for lack of an identity.
- **The shell.** The just-bash `git` lacks `merge -s`, `merge --no-commit`,
  `branch --no-merged`, `rev-list`, `for-each-ref`, and `cat-file`. The
  workflow of the notes uses only commands that both shells have.

**Limits to keep in view.**

- **No push notification for the host.** Neither backend tells the host
  about a push. The workstation runs `git` in a separate account.
- **File budget.** `scripts/file-budget.test.mjs` allows 600 lines for a
  source file. `git-conformance.ts` has 451 lines, so the new cases go in a
  new file.
- **The `repos` tool** shows the first five branches of a repository and a
  count of the rest. A seat lists the branches with `git`.

## The design

**A new reserved namespace, `shared`, holds repositories that every agent
pushes to.** A workspace with several rooms shares each of them across the
rooms, because repositories belong to the workspace.

| Namespace   | Holds                   | Who can push |
| ----------- | ----------------------- | ------------ |
| `templates` | The read-only templates | Nobody       |
| `shared`    | The shared repositories | Every agent  |
| `<agent>`   | The forks of that agent | That agent   |

1. **Reserve the name.** `SHARED = 'shared'` joins `TEMPLATES`. `assertAgent`
   refuses an agent with that name, in `connect` and in each credential call.
   A helper `writableBy(id, agent)` replaces the namespace tests.
2. **Register a shared repository.** Both backends take a new option next to
   `templates`:

   ```ts
   shared: {
     notes: {
       description: 'The notes of the team: facts, decisions, and questions.',
       source: fromDirectory('./notes-seed'),
     },
   },
   ```

   Registration **creates** the repository when it does not exist yet. The
   source becomes the first commit on the default branch, as `ambion`. When
   the repository exists, registration writes no file and moves no ref,
   because the agents own the content. It updates the description when the
   description differs. A later change of the source has no effect.

3. **Define "exists" for a crash.** On `justGitBackend`, `settledRow` marks a
   row `ready` whenever the repository exists, so a crash between
   `createRepo` and the first commit would leave an empty `shared/<name>`
   that counts as existing. The rule is: a repository exists when its
   default branch has a commit. Registration of a row without that commit
   writes the seed commit again. On the workstation, registration builds the
   repository in `.staging` and lands it with one `mv -T`, the pattern of
   the template build. Three details differ from a template: it installs no
   `pre-receive` hook that refuses every push; it sets
   `core.logAllRefUpdates always` and the push rules before the rename; and
   it skips the post-check of the tree (`sameFiles`) for a repository that
   already holds pushes.
4. **Grant the write.** In `justGitBackend`, `credential` returns `write`
   when the namespace is `shared`, and `preReceive` accepts a write token.
   In `workstationGitBackend`, `serve` accepts `git-receive-pack` when
   `$namespace` is `$agent` or `shared`. The preparation rewrites `serve`
   when its text differs, so an existing account picks the change up at the
   next start.
5. **Keep the history.** No ref of a shared repository moves backward or is
   deleted. Any agent can create a branch and add commits to it. A branch
   therefore keeps the record of a dispute for good. `justGitBackend`
   enforces the rule for `shared/*` alone, in the `update` hook, so the
   forks of the agents keep their freedom. The workstation sets
   `receive.denyNonFastForwards` and `receive.denyDeletes` in the config of
   each shared repository, and the two rules match.
6. **Give the seat an author on the workstation.** The agent files that
   `connect` writes into the home (`git-agent.ts`) also set
   `user.name` and `user.email` for `git`, so a commit names the seat on
   both backends. The reflog keeps naming the agent.
7. **Say it in the guidance.** The git note gains one line: `shared/<name>
takes pushes from every agent. Pull and rebase before you push.` The
   sentence "You push only to `<your name>/<name>`" becomes "You push to
   `<your name>/<name>` and to `shared/<name>`", and the sentence about
   forking a template to get something you can push changes to match. The
   `repos` text lists the shared repositories, and its `namespace`
   parameter accepts `shared`.
8. **Decide the sensor pattern.** A sensor source may not come from a
   template. Whether it may come from `shared/*` is a decision below.
9. **Write the trust rows.** Any agent can push junk to a shared
   repository. The rows in `docs/trust.md` and `docs/workstation-git.md`
   say what the design refuses (a force push, a deletion) and what it
   allows (any commit, any new branch).

**The tools stay three: `repos`, `clone`, and `fork`.** A shared repository
needs no new tool.

**A leftover repository stays writable.** The grant rests on the namespace,
and registration tracks no members. A repository in `shared/` whose
registration the host removes stays writable by every agent. A fork that an
older agent named `shared` made becomes a shared repository with no push
rules. The changelog says so.

**Registration stays lazy.** `openWorkspace` checks the transport at once.
Registration runs at the first `connect`, `credentialFor`, or `identityFor`,
so a bad `shared` option fails at the first seat connect, as a bad template
does today.

## The work

| Step | Change                                                                                   | Where                                                                                        |
| ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | `SHARED`, `assertAgent`, `writableBy`                                                    | `packages/workspace/src/git-names.ts`, `git-entry.ts`                                        |
| 2    | The option `shared` and its type                                                         | `packages/workspace/src/git-templates.ts`, both backends                                     |
| 3    | Create-once registration, the credential scope, `preReceive`, and the `update` hook      | `packages/just-bash/src/git/registration.ts`, `backend.ts`, `server.ts`                      |
| 4    | Create-once registration on the git account, the `serve` rule, and the repository config | `packages/workstation/src/git-registration.ts`, `git-prepare.ts`                             |
| 5    | The author identity in the agent's home                                                  | `packages/workstation/src/git-agent.ts`                                                      |
| 6    | The guidance and the `repos` text                                                        | `packages/workspace/src/git-tools.ts`                                                        |
| 7    | The sensor pattern                                                                       | `packages/workspace/src/sensors.ts`, `docs/sensors.md`                                       |
| 8    | The conformance cases in a new file, and the option in `GitConformanceOptions`           | `packages/workspace/src/git-conformance-shared.ts`, `git-conformance.ts`                     |
| 9    | The harnesses pass `shared` through                                                      | `packages/just-bash/test/support/git-harness.ts`, `packages/workstation/test/support/git.ts` |
| 10   | The existing case that expects a refused push outside the namespace                      | `git-conformance.ts` (`pushesOutsideTheNamespaceAreRefused`)                                 |
| 11   | The docs, the comments, the changelog, and the export snapshot                           | The docs listed above, `CHANGELOG.md`                                                        |
| 12   | A room test: two scripted seats push to one shared repository                            | `packages/workspace` room test                                                               |

**The conformance cases** (`gitConformance`, then the OpenSSH tier):

- `list` shows `shared/<name>` with its description, and `list('shared')`
  shows the namespace alone.
- Registration creates the repository once. A second registration with a
  changed source writes no commit and moves no ref.
- A registration after a push keeps the pushed commits.
- A registration that stops after the empty repository exists finishes the
  seed at the next start.
- Two agents each push a commit to `main`, the second from a clone made
  before the first push. The second push is rejected, and after a pull with
  rebase it lands. The case is phrased by outcome, because a push holds the
  bash owner on the just-bash backends and the race may show on the client.
- A force push and a deletion are refused on `main` and on another branch.
- A push of a new branch is accepted, and a peer reads it.
- A push to a template, and a push to another agent's fork, stay refused.
- An agent named `shared` is refused, and gets no credential.
- `fork` of a shared repository gives a fork in the caller's namespace.
- A commit ref for a commit of `shared/<name>` builds and parses.
- A commit on the workstation names the seat as its author.

**The guidance and `repos` texts** each get one case.

**Acceptance.**

1. `pnpm check` passes, and the export snapshot and the golden journals
   change only where the changelog says.
2. The OpenSSH tier passes on the workstation job.
3. A scripted room test drives two seats that clone `shared/notes`, commit,
   push, and read each other's commits.
4. One live run of a two-seat scenario shows a seat that rebases after a
   rejected push. It costs money, so run it once and keep the evidence.

## Later, and out of this change

- **A push notification.** `just-git` has `postReceive`. The workstation has
  a `post-receive` hook that runs in the git account. A host option
  `onPush({ repository, branch, commit, agent })` would let a host wake a
  seat with `room.post`. The change is separate, because the workstation
  needs a channel from the git account to the host.
- **A reminder of what changed.** An activation reminder that lists the new
  commits of a shared repository since the seat last looked. It follows the
  sensor reminder (`sensor-reminder.ts`).
- **Write control by seat.** Every agent of the workspace writes a shared
  repository. A per-seat grant needs a policy on the workspace, and no
  application asks for it yet.
- **More git commands in just-git.** `merge -s ours`, `merge --no-commit`,
  and `branch --no-merged` would shorten the workflow of the notes. The
  workflow does not wait for them.

## Decisions for the owner

1. **The name.** `shared` fits the Workbench notes. `common` and `team` work
   as well. The name is reserved for every workspace.
2. **One type for both registrations.** The plan replaces
   `TemplateRegistration` with a `RepositoryRegistration` that both options
   use. The other way keeps two types with the same fields.
3. **The history rule.** The plan applies it to every ref of `shared/*`,
   through the `update` hook. The server-wide `ServerPolicy` would also bind
   the forks of the agents. The plan avoids that.
4. **Create-once registration.** A change of the source of an existing
   shared repository has no effect. The other way merges the new source
   into the tip, and it can conflict with the work of the agents.
5. **Sensors from a shared repository.** The plan keeps the sensor pattern
   as it is for `templates/` and allows `shared/*`, as it allows an agent
   namespace. The other way refuses `shared/*`, so a sensor definition
   always has one owner.
6. **The backlog entry.** The backlog ends at D22. This page can become D23
   with the condition "an application needs several agents to write one
   repository", and Workbench is that application.

## How Workbench uses it

After Ambion releases the change, Workbench does four things:

1. It updates the dependency, and adds the option
   `shared: { notes: { description, source: fromDirectory('notes/') } }` to
   both git backends: `labRepositories` in `src/host/repositories.ts` and
   the `workstationGitBackend` call in `src/host/workstation.ts`.
2. It adds the seed of the notes to the package. The seed holds the
   `README.md` and the folders of [`docs/notes.md`](docs/notes.md).
3. It adds the skill `keep-notes` to each specialist, and one line about the
   notes to the shared rules.
4. It moves the content of `/shared/bench.md`, `/shared/kit.md`, and
   `/shared/notes.md` into the notes. The library stays read-only.
