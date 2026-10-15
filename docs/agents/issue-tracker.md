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
