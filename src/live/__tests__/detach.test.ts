import { detach } from '../detach';

/** A rejection is a bug that must reach onBug, even when it cannot be printed the ordinary way. */
async function reported(rejection: unknown): Promise<readonly string[]> {
  const bugs: string[] = [];
  detach(Promise.reject(rejection), (message) => bugs.push(message));
  await new Promise<void>((settled) => { setImmediate(() => settled()); });
  expect(bugs).toHaveLength(1);
  expect(bugs[0]?.length ?? 0).toBeGreaterThan(0); // a bug report is never empty text
  return bugs;
}

describe('detach reports every rejection as a bug', () => {
  it('a rejection that cannot be printed still reaches onBug', async () => {
    expect(await reported(Object.create(null))).toEqual(['[object Object]']);
    expect(await reported({ toString: 1 })).toEqual(['[object Object]']);
    expect(await reported(new TypeError('the answer broke'))).toEqual(['TypeError: the answer broke']);
    expect(await reported('plain words')).toEqual(['plain words']);
  });
});
