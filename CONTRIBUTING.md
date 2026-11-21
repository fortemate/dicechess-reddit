# Contributing

Thank you for contributing to **Dice Chess Daily**
(`fortemate/dicechess-reddit`).

## Prerequisites & Setup

Use the Node.js and npm versions pinned in `.node-version`, `mise.toml`, and
`package.json`:

```bash
mise install
mise exec -- npm ci
mise exec -- lefthook install
```

Before pushing or opening a pull request, run the full check suite:

```bash
mise exec -- npm run check
git diff --check
```

## Workflow & Guidelines

- Never commit directly to `main`. Create a focused branch such as
  `feat/short-description`, `bug/short-description`, `docs/short-description`,
  or `ci/short-description`.
- Keep all GitHub-facing text (commits, Issues, pull requests, docs) in English.
- The maintainer reviews and merges pull requests; do not self-merge or push
  release tags.
- Never commit private Fortemate models, weights, opening books, corpora, or
  restricted assets.

## License & CLA

Project-authored code and documentation are licensed under
[AGPL-3.0-only](LICENSE). External contributors must sign the
[Individual Contributor License Agreement](CLA.md) by appending an entry to
[`.github/cla-signatures.json`](.github/cla-signatures.json) in their first pull
request.
