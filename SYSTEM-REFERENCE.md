# Design Sync — System Reference

End-to-end map of how every surface in this project talks to every other one: the
Figma plugin, the `design-tokens` repo, Storybook, Teams/Slack notifications, and the
JIRA-triggered ticket-to-PR agent. Companion to [README.md](README.md) (plugin detail)
and [`design-sync-roadmap-phases-1-11.md`](design-sync-roadmap-phases-1-11.md) (full
phase-by-phase spec). The JIRA agent's own deep-dive lives in
[`JIRA-AGENT.md`](https://github.com/shivanshu-epam/design-tokens/blob/main/JIRA-AGENT.md)
in the `design-tokens` repo.

As of 2026-08-12, plugin release v1.20.0.

---

## 1. The whole system in one picture

`design-tokens.json`, committed in the `design-tokens` GitHub repo, is the only file
every other surface ultimately reads from or writes to. Nothing talks to anything else
directly — every arrow below either passes through that file or through a GitHub
Actions workflow watching that file.

```
                      ┌─────────────────────┐
                      │   Figma (design file) │
                      │   Styles + Variables   │
                      └──────────┬─────────────┘
                                 │  Design Sync plugin (human-launched,
                                 │  no background/headless mode possible —
                                 │  Figma plugin sandbox constraint)
                                 ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                      design-tokens.json                        │◄──── JIRA ticket agent
 │              (design-tokens repo, single source of truth)      │      (opens a PR here,
 └───────┬───────────────────────────────┬───────────────────────┘       never merges it)
         │                               │
         │ push triggers CI              │ push triggers notify
         ▼                               ▼
   ┌───────────────────┐       ┌───────────────────────┐
   │ Storybook rebuild   │       │ Teams / Slack webhook   │
   │ + GitHub Pages       │       │ (sync summary message)  │
   └───────────────────┘       └───────────────────────┘
```

- **`Figma-Github Sync`** (this repo) — the plugin. Reads/writes Styles and Variables,
  renders 5 tabs, opens PRs against `design-tokens`. Runs only while a human has it
  open in Figma.
- **`design-tokens`** — `design-tokens.json` + Storybook + every GitHub Actions
  workflow: CI validation, Storybook deploy, Teams/Slack notify, and both halves of
  the JIRA ticket agent.
- **JIRA** (`epam-ai-ux.atlassian.net`, project `DS`) — ticket intake for token
  change requests that don't originate in Figma at all. One Automation rule is the
  only JIRA-side moving part.

> **The one constraint that shapes everything downstream.** Figma plugins have no
> headless execution mode on a non-Enterprise plan — the plugin only runs while a
> human has the file open and has launched it. So every path that ends with "Figma
> now shows the new value" actually ends with *"the change is live in
> `design-tokens.json`; Figma catches up next time someone opens the plugin and runs
> Fetch & compare."* That's true for a normal Sync-tab PR merge, and it's true for a
> JIRA-triggered PR merge — nothing has a way to push a value into a Figma file
> without a human in that file.

---

## 2. Core loop: bidirectional sync (Figma ↔ GitHub)

The plugin's Sync tab is the only path that writes to both sides. It never commits
directly — every sync opens a pull request, and Figma-side application of GitHub's
values happens immediately, independent of whether that PR has merged yet.

1. **Read Figma** — Styles + Variables (color, typography, shadow, dimension, string,
   boolean) via `code.ts`. No network access in this half.
2. **Read GitHub** — `design-tokens.json` fetched by `ui.ts` via the Contents API
   (`.raw` media type above 1MB).
3. **Diff per key** — added-in-Figma / added-in-GitHub / modified. No default
   resolution — every conflict needs an explicit pick.
4. **Resolve** — per-row segmented toggle: Use Figma / Use GitHub / Skip. Sync button
   stays locked until every conflict has a pick.
5. **Branch + PR** — `design-sync/sync-<timestamp>` off the configured branch.
   Commit, open PR. Never a direct commit.
6. **Apply to Figma** — GitHub-side resolutions write back to Styles/Variables
   immediately — doesn't wait for PR merge.

### Why Figma updates before the PR merges, but GitHub doesn't

This is the detail people trip on first: after a Sync, the Status tab will often
still show a Figma↔GitHub diff. That's correct — the target branch's SHA genuinely
hasn't moved, because the PR is still open. Figma already has the resolved values
(step 6 ran regardless), but GitHub's canonical file catches up only when a human
merges the PR. The Status tab's pending-PR banner exists specifically so this reads
as "expected," not "sync failed."

### Token model: values vs. references

Every token is either a concrete value or a reference to another token
(`{ kind: 'reference', refKey }`). Aliases in Figma Variables are preserved as live
references, not flattened — `resolveToken()` walks the chain on demand. An orphaned
reference (target no longer in Figma's active variable list) falls back to a resolved
snapshot rather than blocking the read.

**Variable write-back — the one asymmetry that's still there.** A token that already
has Figma variable history (`design-sync.variableId` + `modeId` in `$extensions`)
re-links to that same variable on write-back. A token that's brand-new from GitHub —
never existed in Figma — still becomes a Style, because there's no collection/mode to
place a never-before-seen variable into. Write-back also always resolves to a
concrete value; it does not yet emit a native `VARIABLE_ALIAS` even when the source
token is itself a reference.

---

## 3. Storybook: scripted, not automatic

Storybook renders four pages (Colors, Typography, Shadows, Dimensions) straight from
`design-tokens.json`. It rebuilds only when someone deliberately triggers it — never
as a side effect of every commit.

| | |
|---|---|
| **Trigger** | Plugin's Status tab "Rebuild Storybook" button (via GitHub's `workflow_dispatch`), or manual `gh workflow run deploy-storybook.yml`. |
| **Staleness check** | `.storybook-sync.json` is stamped with the git blob SHA of `design-tokens.json` at build time; the Status tab compares that against the live GitHub SHA — no live Storybook deployment needs to be reachable to know it's stale. |
| **Why not automatic** | Deliberate: rebuilding is a reviewed action a human takes after looking at what changed, not a blind side effect of every push. |
| **Local dev check** | `ui.ts` probes `localhost:6006` with a `no-cors` fetch (Storybook's dev server sends no CORS headers, so a normal fetch can't distinguish "port closed" from "no header"). If nothing answers, it shows the exact `npm run storybook` command with a copy button instead of opening a dead tab — **the plugin has no shell access in either execution context and can only detect the dev server, never start it.** |

---

## 4. Teams / Slack notifications

Push-based, triggered from GitHub Actions — not from the plugin. That placement is
deliberate: a webhook URL is a team-shared secret, and a GitHub Actions secret with
one owner beats the same URL duplicated across every contributor's local
`clientStorage` with no rotation story.

1. A sync PR merges — a commit lands on the configured branch, touching
   `design-tokens.json` and the audit log.
2. `notify-on-sync.yml` triggers on push, path-filtered to
   `.design-sync/audit-log.jsonl`.
3. Extracts new entries — diffs the audit log against the previous commit — never
   fires on unrelated pushes to the repo.
4. Posts a formatted message (actor, change summary, commit/PR link) to the
   Teams/Slack webhook URL, stored as a repo secret.

Status: shipped and live (v1.8.0). A companion static "live status" page was built
(v1.11.0) and then explicitly reverted (v1.11.1) — the product decision was that it
wasn't wanted, not that it was broken. Treat that half as rejected, not a gap to fill
later without a fresh ask.

---

## 5. JIRA ↔ GitHub: the ticket-to-PR agent

Everything above starts in Figma. This is the one path that starts somewhere else —
a JIRA ticket — and ends the same place: a reviewed PR against `design-tokens.json`.
Built and validated end-to-end 2026-08-12. It shares nothing with the plugin at
runtime; the only thing the two systems have in common is the file they both
eventually touch.

```
 JIRA ticket moves to        JIRA Automation rule         GitHub Actions
 "Ready for Agent"   ─────►  "Send web request"   ─────►  repository_dispatch
                             POST /repos/…/dispatches      ticket-agent.yml
                                                                  │
                                                                  ▼
                                                       scripts/ticket-agent.mjs
                                                       1. fetch ticket (JIRA REST v2)
                                                       2. parse structured description
                                                       3. resolve + validate against
                                                          the REAL current tokens file
                                                       4. branch → commit → push
                                                       5. gh pr create
                                                                  │
                                                                  ▼
                                                         Pull Request opens
                                                     (human reviews — never
                                                        auto-merged, ever)
                                                                  │
                                       ┌──────────────────────────┴───────────────┐
                                       ▼ merged                                    ▼ closed unmerged
                             transition ticket → Live                 transition ticket → In Design
                             comment: change is live in the           comment: revise + re-queue
                             file (Figma still needs a human
                             to open the plugin to see it)
```

### Ticket format — structured only, by design

Free-text interpretation ("make the button a bit darker") was scoped and deliberately
**parked** — this is a POC proving the structured path first; extending it to natural
language is a real future increment, not something silently missing.

```
Token: category/token-key
Current value: <exact current value>
New value: <the value to change it to>
Reason: <why — goes in the PR body>
```

`Token` splits on the **first** `/` into category + key — everything after that stays
part of the key, including further slashes (token keys in this repo routinely look
like `additional palette/yellow/yellow-5`).

### JIRA status machine

| Status | Meaning |
|---|---|
| To Do | Ticket filed, not yet drafted into the structured format. |
| In Design | Being drafted — *and* where the agent bounces a ticket back to when it can't act on it. Reused deliberately instead of adding a separate "Needs Info" status. |
| Ready for Agent | The trigger status. Moving a ticket here fires the Automation rule. |
| In Review | A PR is open, waiting on a human. |
| Live | Merged. ("Approved" as a separate status was considered and dropped — Storybook's auto-deploy on merge is close enough to instant that a "merged but not live yet" state added no signal.) |

### Every reason the agent refuses to act — never guesses

The core guardrail: if anything is ambiguous, comment and bounce to "In Design."
Never open a branch or PR on an assumption.

| Condition | What happens |
|---|---|
| Missing/unparseable field | Comment lists exactly what's missing. No branch, no PR. |
| Token path doesn't exist | Clarification comment — the category/key combination isn't in the real file. |
| Token is a reference, not a value | Not supported. Silently editing what a reference resolves to would mean editing a *different* token than the one named — refused rather than guessed. |
| Stated "Current value" ≠ real file | Someone else already changed it — bounced for clarification rather than blindly overwriting. |
| Post-edit validation fails | File change reverted (`git checkout --`) before anything is committed; validator's own error text becomes the JIRA comment. |

### Resolving the PR's outcome back to JIRA

`ticket-agent-resolve.mjs` triggers on `pull_request: closed`, filtered at the
workflow level to branches matching `design-sync/agent-*` — a human-authored PR
closing never touches JIRA at all. The issue key is read straight out of the branch
name (`design-sync/agent-{ISSUE-KEY}-{timestamp}`), no extra API round-trip needed.

> **The one non-negotiable guardrail.** Nothing this pipeline opens is ever merged
> automatically — no exceptions, no "safe change" size carve-out. The risk being
> managed is *interpretation* risk (did the agent understand the ticket correctly),
> not change-size risk, so there's no threshold that would make auto-merge safe.
> This is architecturally different from the plugin's own Sync-tab PRs, where a
> human already made the change in Figma and the PR is just formalizing something
> already known-correct.

### Why no GitHub App was needed here (but will be for auto-merge later)

`ticket-agent.yml` runs *inside* the `design-tokens` repo itself, so the
automatically-provided `secrets.GITHUB_TOKEN` — with
`permissions: { contents: write, pull-requests: write }` declared in the workflow —
is enough to push a branch and open a PR. No new GitHub-side identity was
provisioned. That does **not** extend to a future PR-governance/auto-merge agent:
merging or approving is a higher-privilege action than opening, and would need a
distinct GitHub App identity. It's also flagged as a hard requirement that such an
agent's trigger filter must never broaden to match `design-sync/agent-*` branches —
this pipeline's whole guardrail depends on nothing it opens ever getting
auto-merged by something else, either.

---

## 6. Where every credential lives

| Credential | Lives in | Used by | Scope |
|---|---|---|---|
| GitHub fine-grained PAT | Figma `clientStorage` (per machine, never synced) | Plugin's `ui.ts` — all GitHub calls | Contents R/W, Pull requests R/W, Actions R/W, Pages read-only |
| Teams / Slack webhook URL | `design-tokens` repo secret | `notify-on-sync.yml` | One team-shared URL, centrally rotatable — deliberately not stored per-machine |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | `design-tokens` repo secrets | `jira-client.mjs` (both ticket-agent workflows) | HTTP Basic auth against JIRA REST v2 |
| GitHub token in the JIRA Automation rule itself | JIRA Automation rule's web-request header, one-way only | Firing the initial `repository_dispatch` call | Fine-grained PAT, Contents: Read and write, scoped to just this repo — separate credential from the workflow's own `GITHUB_TOKEN` |
| Built-in `secrets.GITHUB_TOKEN` | Auto-provided per workflow run | Both ticket-agent workflows — push branch, open PR | Repo-scoped, expires with the run |

No credential is ever typed into or stored by chat/the assistant — any token pasted
into a conversation accidentally is treated as compromised and revoked immediately,
not reused.

---

## 7. Every edge case, in one place

### Figma ↔ GitHub sync

| Situation | Behavior |
|---|---|
| Two people sync around the same time | Each gets their own branch/PR. Second to merge hits GitHub's normal merge-conflict handling — nothing coordinates or warns ahead of time. |
| Conflicting token, same key changed both sides | No default resolution exists. The Sync button stays locked until every conflict has an explicit Figma / GitHub / Skip pick. |
| Token file over 1MB | GitHub Contents API's default response won't inline it — the plugin requests `Accept: application/vnd.github.raw+json` to get raw bytes instead of metadata. |
| Orphaned reference (alias target no longer exists in Figma) | Falls back to a resolved concrete snapshot rather than blocking the read. |
| New GitHub-only token, never existed in Figma | Write-back creates a Style, never a new Variable — there's no known collection/mode to place a never-before-seen variable in. |
| PAT missing a required scope | Caught and surfaced as the specific missing-permission message, not a generic 403. |
| Local Storybook dev server not running | `no-cors` probe can't distinguish "closed port" from "no CORS header" either way — shown as "can't confirm," with the exact start command and a copy button, never an auto-launch attempt. |

### JIRA ticket agent

| Situation | Behavior |
|---|---|
| Ticket description missing a required field | Comment naming the missing field(s), transition to "In Design," stop before any branch is created. |
| Token path malformed or nonexistent | Clarification comment, stop. No assumption made about what was meant. |
| Token resolves to a reference, not a direct value | Rejected — supported later, not now. Editing the reference's target would silently edit a different token than the one named. |
| Ticket's "Current value" stale vs. real file | Someone else already changed it — bounced for clarification rather than blindly overwriting. |
| Validator fails after the edit is applied | File change reverted (`git checkout --`) before anything is committed; validator's own error text becomes the JIRA comment. |
| PR closed without merging | Ticket bounces to "In Design" with a comment inviting revision + re-queue via "Ready for Agent" again. |
| Human closes a PR unrelated to this agent | Workflow-level branch-name filter (`design-sync/agent-*`) means the resolve workflow never even runs — zero JIRA side effects. |
| JIRA Automation smart-value typed by hand instead of picked | Sends the literal placeholder string as the "issue key" — surfaces as a confusing `404 Issue does not exist` from GitHub, not an obvious typo. Always use JIRA's own `{}` smart-value picker. |
| "Allow GitHub Actions to create and approve pull requests" left off | Every step up through `git push` succeeds; `gh pr create` fails at the very last step with `GitHub Actions is not permitted to create or approve pull requests` — a separate repo-level toggle from the workflow's own declared permissions, both gates must be open. |
| Target JIRA status not reachable from the ticket's current state | `transition()` lists the issue's actually-available transitions and throws with that list rather than failing silently on a mismatched name. |
| Merged PR — does Figma update? | No, automatically. The file is live on GitHub; Figma only reflects it once a human opens the plugin there and runs Fetch & compare. The merge comment on the ticket says this explicitly. |

### Notifications

| Situation | Behavior |
|---|---|
| Unrelated commit pushed to the repo | Path filter (`.design-sync/audit-log.jsonl`) plus a diff-based extraction step means no false-positive notification fires. |
| Webhook URL rotated | One place to update — the repo secret — not N contributors' local settings. |

---

## 8. Known limits — not gaps waiting to be filled

- **No enforcement behind the PR gate.** Sync opens a plain, unreviewed PR; whether
  review/approval is actually required is entirely down to the target branch's
  protection rules in GitHub, outside the plugin's knowledge or control.
- **No auto-merge anywhere in the system** — Sync-tab PRs and JIRA-agent PRs alike
  wait for an explicit human merge, unconditionally.
- **Structured JIRA tickets only.** Free-text interpretation is a scoped,
  deliberately parked future increment — not attempted today.
- **No cascading edits.** Changing a primitive that other tokens reference through
  isn't supported by the JIRA agent; reference tokens are refused outright rather
  than silently cascaded.
- **PAT has no rotation or central management** — sits in per-user `clientStorage`
  indefinitely, four scopes now (Contents, Pull requests, Actions, Pages).
- **No automated test coverage on the plugin's own UI/interaction logic** — only the
  extracted token-schema package has unit tests; `ui.ts`/`code.ts` regressions are
  caught by manual QA only.
- **Figma plugin sandbox has no headless mode** on a non-Enterprise plan — every
  JIRA-agent merge and every GitHub-side edit needs a human to open the plugin
  before Figma itself reflects it.

---

Plugin repo `Figma-Github Sync` · token repo `design-tokens` · JIRA project `DS` at
`epam-ai-ux.atlassian.net`.
