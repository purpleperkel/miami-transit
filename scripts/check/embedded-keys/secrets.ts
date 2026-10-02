import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { invariant } from '../../../src/lib/invariant';

/**
 * Which values the embedded-key guard looks for (plan M4.10). The secrets are the values of
 *   TRANSITLAND_API_KEY, SWIFTLY_API_KEY, and every public-prefixed variable whose name has KEY in it
 * taken from process.env and the repo's .env together — process.env WINS over .env (even when it
 * holds an empty value), exactly as Expo CLI resolves them when it exports (@expo/env 2.4.3: a
 * variable already defined in process.env "IS NOT overwritten", build/index.js). Empty values are
 * skipped. SWIFTLY_AGENCY_KEY is NOT a secret: its value (`miami`) is a URL path segment the bundle
 * legitimately contains.
 *
 * Expo inlines public-prefixed variables into the bundle at export, which is why their NAMES are
 * forbidden there too (scan.ts). The prefix is assembled from pieces in this tracked file, and in
 * every other one, so `--tree` never flags the guard's own source.
 */

/** Expo's public env prefix, assembled so no tracked file spells it out next to a KEY name. */
export const PUBLIC_PREFIX = ['EXPO', 'PUBLIC', ''].join('_');

/** A whole variable name that is public-prefixed with KEY in it, at any length — which variables' VALUES are secrets. */
const PUBLIC_KEY_VARIABLE = new RegExp(`^${PUBLIC_PREFIX}\\w*KEY\\w*$`);

/** The most name characters after the prefix that a public key NAME found in bytes may have (env-var sized). */
export const PUBLIC_NAME_MAX = 50;

/**
 * A public key NAME in bundle or source bytes: a standalone token — no identifier character
 * ([A-Za-z0-9_]) right before it or right after it — of at most PUBLIC_NAME_MAX name characters after
 * the prefix, KEY among them. Hermes packs its string table back to back, so without the bounds a
 * real runtime string (`<prefix>USE_RN_FETCH`) glued to the uppercase strings after it reads as one
 * 300-character "name" whenever KEY turns up somewhere in that run (2026-10-02 false positive).
 */
export const PUBLIC_KEY_TOKEN = new RegExp(`(?<!\\w)${PUBLIC_PREFIX}(?=\\w{0,${PUBLIC_NAME_MAX}}(?!\\w))\\w*KEY\\w*`, 'g');

/** The private key variables (Mac .env, probe scripts only). */
export const KEY_NAMES: readonly string[] = ['TRANSITLAND_API_KEY', 'SWIFTLY_API_KEY'];

export type Secret = { readonly name: string; readonly value: string };

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The repo's .env as name → value (Node's own parser); empty when there is no .env. */
export function readDotEnv(root: string): Readonly<Record<string, string>> {
  invariant(existsSync(join(root, 'package.json')), `${root} is the repo root`);
  const path = join(root, '.env');
  const parsed = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const dotenv = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  invariant(Object.values(dotenv).every((value) => typeof value === 'string'), '.env values are text');
  return dotenv;
}

/** Every secret to look for, by variable name (sorted): process.env over .env, empty values skipped. */
export function resolveSecrets(env: EnvSource, dotenv: EnvSource): Secret[] {
  invariant(typeof env === 'object' && typeof dotenv === 'object', 'secrets come from two name → value maps');
  const names = new Set([...KEY_NAMES, ...Object.keys(dotenv), ...Object.keys(env)].filter(isSecretName));
  const secrets: Secret[] = [];
  for (const name of [...names].sort()) {
    const value = (env[name] !== undefined ? env[name] : dotenv[name])?.trim() ?? '';
    if (value !== '') {
      secrets.push({ name, value });
    }
  }
  invariant(secrets.every((secret) => secret.value.length > 0 && isSecretName(secret.name)), 'only non-empty secret values are kept');
  return secrets;
}

/** A private key variable, or a public-prefixed one with KEY in its name. */
export function isSecretName(name: string): boolean {
  invariant(typeof name === 'string', 'a variable name is text');
  const isPublicKey = PUBLIC_KEY_VARIABLE.test(name);
  invariant(!isPublicKey || name.startsWith(PUBLIC_PREFIX), 'a public key name carries the public prefix');
  return KEY_NAMES.includes(name) || isPublicKey;
}

/** `text` with every secret value replaced — the last line of defence for "never print a value". */
export function redact(text: string, secrets: readonly Secret[]): string {
  invariant(secrets.every((secret) => secret.value.length > 0), 'only non-empty values are redacted');
  const redacted = secrets.reduce((line, secret) => line.split(secret.value).join(`<${secret.name} value>`), text);
  invariant(secrets.every((secret) => !redacted.includes(secret.value)), 'no secret value survives redaction');
  return redacted;
}
