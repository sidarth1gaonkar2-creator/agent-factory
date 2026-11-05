import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClient } from '../src/config.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_TEMPLATES = join(ROOT, 'test', 'fixtures', 'templates');

// A valid raw client config; tests override pieces of it.
export function rawClient(over = {}) {
  return {
    name: 'Test Spa',
    slug: 'tspa',
    timezone: 'America/Chicago',
    spokenTimezone: 'Central',
    hours: { open: '09:00', close: '17:00', days: { sun: 'closed', sat: { open: '10:00', close: '14:00' } } },
    hoursText: 'Monday to Friday 9 to 5',
    areaCode: '615',
    receptionist: 'Claire',
    services: {
      consultation: { label: 'Consultation', minutes: 30, aliases: ['consult'] },
      facial: { label: 'Signature Facial', minutes: 60, aliases: ['facial', 'Classic Facial'] },
    },
    consultService: 'consultation',
    frontDesk: ['waxing'],
    knowledgeBase: 'kb.md',
    ...over,
  };
}

export function client(over = {}, baseDir = ROOT) {
  return normalizeClient(rawClient(over), baseDir);
}

export const CANONICAL = {
  forbidden: ['Elevate', 'Lumen', 'Nashville Skin Society', 'Toxxology'],
  worker: { serviceFields: { label: 'label', minutes: 'minutes', aliases: 'aliases' } },
};
