import { invariant } from './invariant';

/**
 * Result: expected failures are values, not exceptions. A function that can fail in a way the
 * caller must handle (network, decode, missing key…) returns `Result<T, E>`; a `catch` either
 * rethrows or converts the error into `err(...)` — it never swallows it.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  const result: Ok<T> = Object.freeze({ ok: true, value });
  invariant(Object.isFrozen(result), 'ok() must return an immutable Result');
  invariant(Object.is(result.value, value), 'ok() must carry exactly the value it was given');
  return result;
}

export function err<E>(error: E): Err<E> {
  invariant(error !== undefined && error !== null, 'err() needs an error — an absent error hides the failure');
  const result: Err<E> = Object.freeze({ ok: false, error });
  invariant(Object.isFrozen(result), 'err() must return an immutable Result');
  return result;
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  invariant(typeof result === 'object' && result !== null, 'isOk() needs a Result object');
  invariant(typeof result.ok === 'boolean', 'a Result carries a boolean ok tag');
  return result.ok;
}
