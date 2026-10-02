import { FloorClock } from '../floor-clock';

/**
 * mfix10 fix round 4 (S1): the floor clock Swiftly's 30 s floor runs on — the awake clock (performance.now(),
 * which on iOS stops while the phone sleeps) plus the sleep inside every spell out of the foreground,
 * measured on the wall clock. Both clocks are hand-moved here.
 */

/** A phone's two clocks, in ms: `awake` stops while it sleeps, `wall` never does. */
type Clocks = { awake: number; wall: number };

/** A floor clock over `clocks`, the awake clock starting at 0 as performance.now() does. */
function floorClock(clocks: Clocks): FloorClock {
  const clock = new FloorClock(() => clocks.awake, () => clocks.wall);
  expect(clock.now()).toBe(clocks.awake); // nothing slept yet: the floor clock reads the awake clock
  expect(clock.away).toBe(false); // the app starts in the foreground
  return clock;
}

describe('FloorClock (mfix10 fix round 4): awake ms plus the sleep inside every spell away', () => {
  it('the sleep inside a spell away is counted on return, and time the phone stayed awake is not counted twice', () => {
    const clocks: Clocks = { awake: 5_000, wall: 1_790_872_200_000 };
    const clock = floorClock(clocks);
    clock.background(); // the phone locks
    clocks.wall += 40_000; // 40 s asleep: the awake clock does not move
    clock.foreground();
    expect(clock.now()).toBe(45_000);
    clock.background(); // another app, the phone awake: both clocks run
    clocks.awake += 20_000;
    clocks.wall += 20_000;
    clock.foreground();
    expect(clock.now()).toBe(65_000); // 20 s, once
    clock.background(); // 10 s in another app, then 30 s asleep
    clocks.awake += 10_000;
    clocks.wall += 40_000;
    clock.foreground();
    expect(clock.now()).toBe(105_000);
  });

  it('a wall clock set back while away adds nothing, a return with no departure adds nothing, and leaving twice keeps the first mark', () => {
    const clocks: Clocks = { awake: 0, wall: 1_790_872_200_000 };
    const clock = floorClock(clocks);
    clock.foreground(); // the mount's resume: the app never left
    expect(clock.now()).toBe(0);
    clock.background();
    clocks.wall -= 3_600_000; // the phone's clock is corrected an hour back while it sleeps
    clock.foreground();
    expect(clock.now()).toBe(0);
    clock.background(); // inactive (Control Center)...
    clocks.wall += 10_000;
    clock.background(); // ...then the background: the spell began at the first report
    clocks.wall += 10_000;
    expect(clock.away).toBe(true);
    clock.foreground();
    expect([clock.now(), clock.away]).toEqual([20_000, false]);
  });
});
