# src/lib

Small, framework-independent helpers.

Current contents:

- `theme.ts` — light/dark theme (same behaviour as Doclight)
- `utils.ts` — `cn()` class name helper
- `is-tauri.ts` — detects whether the app runs inside Tauri
- `locale.ts` — value entry and edit text per locale (es-ES default, en-US):
  `parseUserInput` (numbers, %, currency, dates, times, booleans → canonical
  input + number format), `toEditText`, Excel serial dates, number format
  classification. Tests in `locale.test.ts`.

Planned: number formats (general, number, currency, %, date, custom).
