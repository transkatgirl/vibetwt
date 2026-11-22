import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './x-auth.js';

export const DEFAULT_INTENSITY_PCT = 60;

export async function loadSettings(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

export const saveSettings = (dir, settings) => writePrivateJson(join(dir, 'settings.json'), dir, settings);

export function startingIntensity(saved) {
  return Number.isInteger(saved) && saved >= 0 && saved <= 100 ? saved : DEFAULT_INTENSITY_PCT;
}
