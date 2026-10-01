import { invariant } from '../lib/invariant';
import { err } from '../lib/result';

/**
 * Starts `work` without awaiting it (a poll, a Keychain read). Everything in src/live reports
 * expected failures as Result values, so a rejection here is a BUG — a broken invariant. It must not
 * vanish: React Native tracks unhandled promise rejections only in development builds
 * (react-native 0.86 Libraries/Core/polyfillPromise.js enables Hermes' tracker `if (__DEV__)`), so in
 * a published update it would disappear without a trace. Instead the bug is handed to `onBug`, which
 * puts it in the live state (`internalError`, shown by Diagnostics) in every build; the rejection
 * itself becomes that Err value and nothing is left floating.
 */
export function detach(work: Promise<unknown>, onBug: (message: string) => void): void {
  invariant(typeof work.catch === 'function', 'detach() starts a promise');
  invariant(typeof onBug === 'function', 'a detached task reports its bugs');
  void work.catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    onBug(message);
    return err(message);
  });
}
