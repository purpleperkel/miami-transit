import { err, ok } from '../../../lib/result';
import { settleProbe } from '../probe-kit';

describe('settleProbe', () => {
  it('passes a probe outcome through unchanged', async () => {
    await expect(settleProbe('demo', () => ok('evidence'), 1000)).resolves.toEqual(ok('evidence'));
    await expect(settleProbe('demo', () => Promise.resolve(err('reason')), 1000)).resolves.toEqual(err('reason'));
  });

  it('turns a thrown error into err() naming the probe', async () => {
    const outcome = await settleProbe(
      'geocode',
      () => {
        throw new Error('kCLErrorDomain 8');
      },
      1000,
    );
    expect(outcome).toEqual(err('geocode: kCLErrorDomain 8'));
    expect(outcome.ok).toBe(false);
  });

  it('turns a rejected promise into err(), even when the rejection is not an Error', async () => {
    await expect(settleProbe('fetch', () => Promise.reject(new Error('offline')), 1000)).resolves.toEqual(
      err('fetch: offline'),
    );
    await expect(settleProbe('fetch', () => Promise.reject('socket closed'), 1000)).resolves.toEqual(
      err('fetch: socket closed'),
    );
  });

  it('fails a step that never answers once its time limit passes', async () => {
    const started = Date.now();
    const outcome = await settleProbe('location', () => new Promise(() => undefined), 25);
    expect(outcome).toEqual(err('location: no answer within 0.025 s'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
