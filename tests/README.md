# tests

- `unit/` — Vitest unit tests (`npm test`). Tests may also live next to the
  code as `src/**/*.test.ts`.

Planned:

- `corpus/` — real-world `.xlsx` / `.csv` files used for import/export
  fidelity checks (private files go in `corpus/private/`, which is git-ignored)
- `e2e/` — end-to-end tests of the desktop app
- `bench/` — performance benchmarks for the targets in `docs/PLAN.md`
