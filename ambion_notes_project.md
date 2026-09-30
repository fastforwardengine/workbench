# Project: shared git repositories in Ambion

**This page briefs one change to Ambion: a repository that every agent of a
workspace can push to.** Workbench needs it for its team notes
([`docs/notes.md`](docs/notes.md)). The change is small in code and touches
one design decision, so this page states the finding, the design, the work,
and the questions that the owner of Ambion decides.

- **Reviewed:** `../ambion` at commit `c0f4711f` on `main` (one commit behind
  `origin/main`), on 2026-09-30. The 0.5.0 scope is the sensor lifecycle.
  This change is not in it.
- **Status:** a proposal. No code exists.
- **Rule for the code:** Ambion promises no compatibility before 1.0.0, so
  the change adds no alias and no migration, and the changelog names it.

## The need

**Workbench wants one place where all specialists keep what they conclude.**
Each specialist reads and writes it, and a disagreement stays visible until
evidence settles it. Git already gives the pieces: an author and a time for
each change, a rejected push for a lost race, and a branch for a dispute.
Today the team keeps this state in two Markdown files that it rewrites as a
whole, so two seats that write at once lose one edit.

## What the review found

**The git backend has one pusher for each repository, by decision.**
[`docs/git.md`](../ambion/docs/git.md#decisions-taken) states it: "One agent
pushes to a repository: its owner. A peer reads the repository and forks it.
Two agents work on one task through two forks." A shared repository reverses
that decision for one namespace.

**The rule lives in six places.** A change touches each of them.

| Place                                                   | What it does today                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/workspace/src/git-names.ts` (13, 37, 47)      | `TEMPLATES` is the one reserved name. `assertAgent` refuses it. `readOnly` marks a template         |
| `packages/just-bash/src/git/backend.ts` (145)           | `scope` is `write` when the namespace of the repository equals the agent name, and `read` otherwise |
| `packages/just-bash/src/git/server.ts` (73 to 81)       | `preReceive` refuses a push to a template, and a push with a read token                             |
| `packages/workstation/src/git-prepare.ts` (47)          | The `serve` script refuses `git-receive-pack` when `$namespace` differs from `$agent`               |
| `packages/workspace/src/git-tools.ts` (66, 67, 81, 117) | The guidance and the `repos` text: "You push only to `<your name>/<name>`"                          |
| `packages/*/src/git-*registration*.ts`                  | Registration creates and updates templates. Nothing creates any other repository except `fork`      |

**Ambion has the tools for a shared repository already.**

- `fork` accepts any repository as its source, so an agent can fork a shared
  repository.
- `clone` gives a working copy whose `origin` keeps the push rights of the
  source. That is the tool a seat uses for a shared repository.
- The commit ref form (`ambion://workspace/<workspace>/repo/<repository>/…`)
  holds any ID of the form `<namespace>/<name>`, so `shared/notes` needs no
  change there.
- The author of a commit is the agent on both backends. The just-bash `git`
  locks the author. The `serve` script of the workstation sets the committer,
  and the reflog names the agent.
- `just-git` 1.8.2 has what the server needs. `ServerPolicy` holds
  `protectedBranches`, `denyNonFastForward`, and `denyDeletes`, and the hooks
  hold `postReceive` (`dist/server/index.d.ts`, lines 300 to 302 and 654).
  The workstation gets the same rules from `receive.denyNonFastForwards` and
  `receive.denyDeletes` in the repository config.
- The server orders pushes already. Each ref update compares the old commit,
  and a push that lost the race fails. Two seats that push to one branch
  therefore rebase and push again.

**Limits to keep in view.**

- **Global server policy.** `ServerPolicy` applies to every repository of
  the server. A protected `main` also protects the forks of the agents.
- **No push notification for the host.** Neither backend tells the host
  about a push. The workstation runs `git` in a separate account.
- **File budget.** `scripts/file-budget.test.mjs` allows 600 lines for a
  source file. `git-conformance.ts` has 451 lines, so the new cases go in a
  new file.

## The design

**A new reserved namespace, `shared`, holds repositories that every agent
pushes to.**

| Namespace   | Holds                   | Who can push |
| ----------- | ----------------------- | ------------ |
| `templates` | The read-only templates | Nobody       |
| `shared`    | The shared repositories | Every agent  |
| `<agent>`   | The forks of that agent | That agent   |

1. **Reserve the name.** `SHARED = 'shared'` joins `TEMPLATES`. `assertAgent`
   refuses an agent with that name, in `connect` and in each credential call.
   A backend can still reserve more names.
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

   Registration **creates** the repository when it is absent, with the
   source as the first commit on the default branch, as `ambion`. When the
   repository exists, registration writes nothing to its files or refs,
   because the agents own the content. It updates the description when the
   description differs. A later change of the source has no effect, and the
   page says so.

3. **Grant the write.** In `justGitBackend`, `credential` returns `write`
   when the namespace is `shared`. The `preReceive` hook allows the push for
   a write token. In `workstationGitBackend`, the `serve` script accepts
   `git-receive-pack` when `$namespace` is `$agent` or `shared`. The
   preparation rewrites `serve` when its text differs, so an existing
   account picks the change up at the next start.
4. **Keep the history.** A push to a shared repository cannot delete the
   default branch or move it backward. `justGitBackend` refuses it in
   `preReceive`. The workstation sets `receive.denyNonFastForwards` and
   `receive.denyDeletes` when it creates the repository. Any other branch
   accepts a push, so a dispute can live on a branch. The reflog names the
   agent on the workstation.
5. **Say it in the guidance.** The git note gains one line: `shared/<name>
takes pushes from every agent. Pull and rebase before you push.` The
   sentence "You push only to `<your name>/<name>`" changes to "You push to
   `<your name>/<name>` and to `shared/<name>`". The `repos` text lists the
   shared repositories, and the `namespace` parameter accepts `shared`.
6. **Write the trust rows.** Any agent can push junk to a shared
   repository. The rows in `docs/trust.md` and `docs/workstation-git.md`
   say what the design refuses (force push, deletion of the default branch)
   and what it allows (any commit, any branch).

**The tools stay three: `repos`, `clone`, and `fork`.** A shared repository
needs no new tool. A seat uses `clone`, then `git` in `bash`.

## The work

| Step | Change                                                                                                        | Where                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | `SHARED`, `assertAgent`, a helper `writableBy(id, agent)` in place of the namespace test                      | `packages/workspace/src/git-names.ts`, `git-entry.ts`                   |
| 2    | The option `shared` and its type; one type for both registrations                                             | `packages/workspace/src/git-templates.ts`, both backends                |
| 3    | Create-once registration on `justGitBackend`; the credential scope; the `preReceive` rule and the branch rule | `packages/just-bash/src/git/registration.ts`, `backend.ts`, `server.ts` |
| 4    | Create-once registration on the git account; the `serve` rule; the repository config                          | `packages/workstation/src/git-registration.ts`, `git-prepare.ts`        |
| 5    | The guidance and the `repos` text                                                                             | `packages/workspace/src/git-tools.ts`                                   |
| 6    | The conformance cases, in a new file                                                                          | `packages/workspace/src/git-conformance-shared.ts`                      |
| 7    | The docs, the changelog, and the export snapshot                                                              | `docs/git.md`, `workstation-git.md`, `trust.md`, `CHANGELOG.md`         |
| 8    | A room test: two scripted seats push to one shared repository                                                 | `packages/workspace` room test                                          |

**The conformance cases** (`gitConformance`, then the OpenSSH tier):

- `list` shows `shared/<name>` with its description, and `list('shared')`
  shows the namespace alone.
- Registration creates the repository once. A second registration with a
  changed source writes no commit and moves no ref.
- A registration after a push keeps the pushed commits.
- Two agents each push a commit to `main` one after the other, and the
  second push rebases and lands. Two pushes at once give one success and one
  rejection.
- A force push to `main`, and the deletion of `main`, are refused.
- A push of a new branch is accepted, and a peer reads it.
- A push to a template, and a push to another agent's fork, stay refused.
- An agent named `shared` is refused, and gets no credential.
- `fork` of a shared repository gives a fork in the caller's namespace.
- A commit ref for a commit of `shared/<name>` builds and parses.

**The guidance and `repos` texts** each get one case, in the same file as
today's cases.

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
- **A per-room repository.** Repositories belong to the workspace. A
  workspace with several rooms shares each shared repository across the
  rooms. That is what Workbench wants.

## Decisions for the owner

1. **The name.** `shared` fits the Workbench notes. `common` and `team` work
   as well. The name is reserved for every workspace.
2. **One type for both registrations.** The plan replaces
   `TemplateRegistration` with a `RepositoryRegistration` that both options
   use. The other way keeps both types with the same fields.
3. **Global branch protection.** `justGitBackend` sets `protectedBranches`
   for the whole server, so the fork of an agent also protects its own
   `main`. The alternative is a check in `preReceive` that applies to
   `shared/*` alone. The plan takes the check.
4. **Create-once registration.** A change of the source of an existing
   shared repository has no effect. The alternative merges the new source
   into the tip, and it can conflict with the agents' work.
5. **The backlog entry.** The backlog ends at D22. This page can become D23
   with the condition "an application needs several agents to write one
   repository", and Workbench is that application.

## How Workbench uses it

After Ambion releases the change, Workbench does four things:

1. It updates the dependency, and adds the option
   `shared: { notes: { description, source: fromDirectory('notes/') } }` to
   `labRepositories` in `src/host/repositories.ts`.
2. It adds the seed of the notes to the package. The seed holds the
   `README.md` and the folders of [`docs/notes.md`](docs/notes.md).
3. It adds the skill `keep-notes` to each specialist, and one line about the
   notes to the shared rules.
4. It moves the content of `/shared/bench.md` into the notes, and drops that
   file. The library stays read-only.
