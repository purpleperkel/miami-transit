import Constants from 'expo-constants';
import { fetch as expoFetch } from 'expo/fetch';

import { type PlanFetch, PolitePlanClient, type PlanResponseLike } from '@/domain/routes/polite-client';
import { invariant } from '@/lib/invariant';

/**
 * The app's ONE Transitous client (plan M10a.3, transitous#2538: open source, non-commercial, FEW
 * requests). Every route options sheet asks through this single PolitePlanClient, so its 60 s answer
 * cache, its debounce and its one-request-in-flight rule hold across the whole app session — reopening
 * the sheet for the same trip within the minute costs no request. It holds no user data; recent places
 * persist on their own (recent-places.ts).
 *
 * Its fetch is expo/fetch with an abort timer over the WHOLE exchange (headers and body), as the
 * polite client requires: a hung request would otherwise hold the one request slot. The User-Agent
 * names the app's version from app.json (expo-constants), never a literal here.
 */

/** A Transitous answer that takes longer than this is abandoned (the sheet then offers Apple Maps). */
export const PLAN_TIMEOUT_MS = 15_000;

/** The version the User-Agent names when the app's config carries none (it always does in a build). */
const UNKNOWN_VERSION = 'unknown';

const SHARED: { client: PolitePlanClient | null } = { client: null };

/** The app's Transitous client, made on first use. */
export function appPlanClient(): PolitePlanClient {
  const client = SHARED.client ?? new PolitePlanClient({ fetch: timedPlanFetch, clock: () => Date.now(), sleep: sleepMs, appVersion: appVersion() });
  SHARED.client = client;
  invariant(SHARED.client === client, 'one client serves the app');
  invariant(client instanceof PolitePlanClient, 'the app asks Transitous politely');
  return client;
}

/** app.json's expo.version, as the User-Agent names it. */
export function appVersion(): string {
  const version = Constants.expoConfig?.version;
  const named = typeof version === 'string' && /^\S+$/.test(version) ? version : UNKNOWN_VERSION;
  invariant(/^\S+$/.test(named), 'the version is one token');
  invariant(named === version || named === UNKNOWN_VERSION, 'the version is the config\'s, or says it is unknown');
  return named;
}

/** expo/fetch under one abort timer for the headers AND the body; the body is read before the timer stops. */
export const timedPlanFetch: PlanFetch = async (url, init) => {
  invariant(url.startsWith('https://') && init.method === 'GET', 'Transitous is asked over https with a GET');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
  try {
    const response = await expoFetch(url, { method: init.method, headers: { ...init.headers }, signal: controller.signal });
    const text = await response.text();
    const answer: PlanResponseLike = { status: response.status, headers: response.headers, json: async () => JSON.parse(text) as unknown };
    invariant(Number.isSafeInteger(answer.status), 'an answer has a status');
    return answer;
  } finally {
    clearTimeout(timer);
  }
};

function sleepMs(ms: number): Promise<void> {
  invariant(Number.isFinite(ms) && ms >= 0, `a wait is a non-negative number of ms, got ${ms}`);
  const slept = new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  invariant(typeof slept.then === 'function', 'the wait ends later');
  return slept;
}
