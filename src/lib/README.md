# src/lib

Small, framework-independent helpers.

Current contents:

- `theme.ts` — light/dark/system theme (same behaviour as Doclight)
- `settings.ts` — persisted user settings (theme, recent files, default font,
  CSV defaults) in localStorage, validated field by field
- `number-formats.ts` — number format presets, code builders, decimals
  stepping, es localization of codes and the preview formatter used by the
  "Formato de celdas" dialog
- `utils.ts` — `cn()` class name helper
- `is-tauri.ts` — detects whether the app runs inside Tauri
- `locale.ts` — value entry and edit text per locale (es-ES default, en-US):
  `parseUserInput` (numbers, %, currency, dates, times, booleans → canonical
  input + number format), `toEditText`, Excel serial dates, number format
  classification. Tests in `locale.test.ts`.
