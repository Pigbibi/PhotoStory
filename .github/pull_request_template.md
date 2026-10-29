## Problem and resulting behavior

<!-- What is wrong today, and what changes for the user once this merges. -->

## Validation

List the checks actually run and their results. State which checks you did not
run and why. The commands are in the verification section of `AGENTS.md`:

```bash
npm ci && npm test && npm run build
```

## Risk and documentation

Explain relevant compatibility, permissions, data and documentation changes.
Follow `AGENTS.md` and `.github/engineering.md`.

## Checklist

- [ ] The change is focused and contains no unrelated edits.
- [ ] Examples, logs, fixtures, and migrations contain no OneDrive tokens,
      account identifiers, photo content, or personal review notes.
- [ ] Behavior changes are reflected in `README.md` and `README.zh-CN.md` in the
      same pull request.
- [ ] Changes to what is read from OneDrive, what is written to D1 or R2, or what
      is published are stated above rather than implied.
