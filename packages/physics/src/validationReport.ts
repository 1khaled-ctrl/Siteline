import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validation results the tests record, shown in the app's "How we checked it" panel. Node only. */
export const VALIDATION_PATH = resolve(
  fileURLToPath(new URL('../../../tests/reference/validation.json', import.meta.url)),
);

export function recordValidation(section: string, value: Record<string, unknown>): void {
  const existing = existsSync(VALIDATION_PATH)
    ? (JSON.parse(readFileSync(VALIDATION_PATH, 'utf8')) as Record<string, unknown>)
    : {};
  existing[section] = { ...value, recordedUtc: new Date().toISOString() };
  mkdirSync(dirname(VALIDATION_PATH), { recursive: true });
  writeFileSync(VALIDATION_PATH, `${JSON.stringify(existing, null, 1)}\n`);
}
