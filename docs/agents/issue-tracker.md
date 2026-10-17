# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `goncalvesjoao/open-akiya`. Use authenticated `gh` commands with an explicit `--repo goncalvesjoao/open-akiya` argument.

- Create issues with `gh issue create`, passing multiline bodies through `--body-file`.
- Read issues with `gh issue view <number> --json number,title,body,labels,comments`.
- List issues with `gh issue list`; check existing issues before publishing to avoid duplicates.
- Apply labels with `gh issue edit <number> --add-label <label>`; preserve unrelated labels and existing status labels.
- Use `gh issue comment` for explicitly authorized comments and `gh issue close` for explicitly authorized closure.

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the GitHub issue.

## Pull requests as a triage surface

**PRs as a request surface: no.** External PRs are not automatically included in triage discovery. Explicitly named PRs may still be reviewed.

GitHub shares a number space across issues and PRs. Resolve an ambiguous number with `gh pr view` and fall back to `gh issue view`.

## Ship-it identity

Use machine-account mode with GitHub account `itsjohngon`, commit
identity `ItsJohnGon <itsjohngon@gmail.com>`, and human reviewer
`goncalvesjoao` for `github.com/goncalvesjoao/open-akiya`.

copilot_review: true

Request Copilot review during the PR workflow. This choice does not
configure GitHub automatic review.

Before every Ship-it run, including delegated or nested work, resumed
runs, and scheduled ticks, reload this policy. Resolve the helper with
`git rev-parse --path-format=absolute --git-common-dir`, then prefix
every Ship-it gh/git command with:
`<absolute-git-common-dir>/ship-it/run --account itsjohngon`.
Use explicit GitHub repository/host arguments.

Provision `ship-it/run` and sibling `ship-it/config.json` privately
inside Git's common directory on each machine or independent clone.
Linked worktrees share this setup. Keep credentials and absolute
machine paths untracked. Machine mode uses `gh-login` authentication
with an isolated `ship-it/gh` directory inside Git's common directory.
Browser login uses `--insecure-storage`, saving the credential in plaintext
in its private `hosts.yml`. Keep the directory at mode 700 and `hosts.yml`
at mode 600. The helper reads that credential and uses an isolated
temporary GH_CONFIG_DIR for commands.

The helper verifies the login on every invocation and applies the
configured author and committer identity. Standard GitHub HTTPS and
SSH remotes are supported. Nonstandard remotes require separate review.

Missing setup, credentials, policy disagreement, or identity
verification failure stops GitHub access and Git writes/network
operations without fallback to another account, ambient credentials,
connectors, or SSH agents. Local inspection and drafting may continue.
Pause affected monitoring and report the blocker.

Pass this policy, expected login, target checkout, and the installed
setup-ship-it references/github-identity.md path to delegated workers.
Require nested workers to forward them. Include these instructions in
saved monitoring prompts.

For machine-authored PRs, request review from `goncalvesjoao` only at
`status/ready-for-merge` or `status/blocked`, and verify the request or
an existing human review. `status/ready-for-review` does not trigger
human review. If required human approval is the remaining gate after
independent work finishes, hand off as blocked.

If the PR is unassigned, assign `goncalvesjoao`; preserve existing
assignments. An unavailable or ineligible reviewer leaves handoff
incomplete. Preserve all upstream approval gates.
