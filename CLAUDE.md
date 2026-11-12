# Project guidelines

## Git workflow

- One logical change per commit: a feature, a bug fix, a refactor or docs, never mixed.
- Use Conventional Commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `test(scope):`, `docs:`, `chore:`.
- A bug fix gets its own `fix:` commit whose body says what was wrong and why, e.g. `fix(time): stop chrono resolving "1st nov" to next year` with a line on the cause.
- Stage specific files, never `git add .`. Before committing, run `git status` and `npx tsc --noEmit`, and run `npx vitest run` if tests exist.
- Never commit `.env`, API keys or `data/*.db`.
- After each commit, push to `origin main` and show me the commit message.

## Code style

- No comments in source files: no inline `//` comments, no block comments, no JSDoc, no commented-out code, and no file header comments. This applies to `.ts`, `.tsx`, `.js`, `.css` and config files.
- Make code explain itself through clear names for functions, variables and types, small functions, and early returns.
- The reasoning behind decisions goes in `DESIGN.md` and in commit message bodies, not in code.
- The only exception is `.env.example`, which keeps its one-line description above each setting.
