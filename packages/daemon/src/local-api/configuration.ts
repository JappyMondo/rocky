import { z } from 'zod';
import { SECRET_KEY_PATTERN, REDACTED } from '../config/redaction.js';

/** Hide literal env/header values as well as explicitly secret-bearing keys. */
export function configurationView(value: unknown, hidden = false): unknown {
  if (typeof value === 'string')
    return hidden && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
      ? REDACTED
      : value;
  if (Array.isArray(value))
    return value.map((item) => configurationView(item, hidden));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        configurationView(
          child,
          hidden ||
            (key !== 'secretEnv' && SECRET_KEY_PATTERN.test(key)) ||
            key === 'env' ||
            key === 'headers',
        ),
      ]),
    );
  return value;
}

/** JSON Merge Patch, with redacted values preserving the saved value. */
export function mergeConfiguration(current: unknown, patch: unknown): unknown {
  if (patch === REDACTED) {
    if (current === undefined)
      throw new Error('A redacted placeholder needs an existing value.');
    return current;
  }
  if (Array.isArray(patch))
    return patch.map((item, index) =>
      restoreMasked(
        Array.isArray(current)
          ? item && typeof item === 'object' && 'name' in item
            ? current.find(
                (saved) =>
                  saved &&
                  typeof saved === 'object' &&
                  'name' in saved &&
                  saved.name === item.name,
              )
            : current[index]
          : undefined,
        item,
      ),
    );
  if (!patch || typeof patch !== 'object') return patch;
  const result: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Invalid configuration key.');
    if (value === null) delete result[key];
    else result[key] = mergeConfiguration(result[key], value);
  }
  return result;
}

/** Array entries replace wholesale; only explicit markers inherit old data. */
function restoreMasked(current: unknown, value: unknown): unknown {
  if (value === REDACTED) return mergeConfiguration(current, value);
  if (Array.isArray(value)) return mergeConfiguration(current, value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Invalid configuration key.');
      const previous =
        current && typeof current === 'object' && Object.hasOwn(current, key)
          ? (current as Record<string, unknown>)[key]
          : undefined;
      return [key, restoreMasked(previous, child)];
    }),
  );
}

export const configurationPatchSchema = z.strictObject({
  revision: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
});
