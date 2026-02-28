import { sanitizeName } from './utils';

export function classifyEntityGroup(name: string): string {
  const value = String(name || '').toLowerCase();
  if (/(log|audit|event|trace|history)/.test(value)) return 'logs';
  if (/(config|setting|preference|policy|rule)/.test(value)) return 'config';
  if (/(order|invoice|payment|transaction|purchase|ledger|shipment|booking)/.test(value)) return 'transactions';
  return 'master_data';
}

export function detectSensitivityByName(name: string): string {
  const value = String(name || '').toLowerCase();
  if (/(email|phone|mobile|ssn|tax|dob|birth|address|name|contact)/.test(value)) return 'pii';
  if (/(amount|price|cost|revenue|invoice|payment|balance|ledger|salary)/.test(value)) return 'financial';
  return 'normal';
}

export function riskLevelFromSensitivity(sensitivity: string): string {
  if (sensitivity === 'financial') return 'high';
  if (sensitivity === 'pii') return 'medium';
  return 'low';
}

export function inferDataTypeFromValue(value: unknown): string {
  if (value === null || value === undefined) return 'text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'numeric';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'timestamp';
  if (typeof value === 'object') return 'jsonb';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    if (!Number.isNaN(Number(value)) && value.trim() !== '') return 'numeric';
  }
  return 'text';
}

export function sampleValueForColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return '[object]';
    }
  }
  return String(value).slice(0, 240);
}
