import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { FOLLOW_STORE } from '../../map/follow';
import { press } from '../../stations/__tests__/press';
import { VehicleSheet, VehicleSheetView } from '../VehicleSheet';

/**
 * M6.6: the vehicle sheet — the line, where its trip ends, its next stops by the timetable, and the
 * Follow button, which drives the SAME follow store the map's camera reads (follow.test.tsx). Stops are
 * synthetic here; the real ones are repo-next-stops' (ScheduleRepo.nextStops on the real DB).
 */

const NOW_S = 1_790_769_600;

afterEach(async () => {
  FOLLOW_STORE.stop();
  await unmountAll();
});

describe('VehicleSheet (M6.6)', () => {
  it('lists the next stops with their scheduled minutes', async () => {
    const outcome = {
      kind: 'next-stops' as const,
      vehicleKey: '20260930:1403245',
      lineId: 'MM_INNER' as const,
      mode: 'mover' as const,
      destination: 'Government Center',
      stops: [
        { tripIdx: 2503, stationKey: 'mover:miami-avenue', name: 'Miami Avenue', epoch: NOW_S + 30, arrS: 28_830 },
        { tripIdx: 2503, stationKey: 'mover:government-center', name: 'Government Center', epoch: NOW_S + 150, arrS: 28_950 },
        { tripIdx: 2506, stationKey: 'mover:wilkie-d-ferguson', name: 'Wilkie D Ferguson', epoch: NOW_S + 210, arrS: 29_010 },
      ],
    };
    const tree = await renderPrimitive(<VehicleSheetView outcome={outcome} nowS={NOW_S} following={false} onToggleFollow={jest.fn()} />);
    const stops = hostsByTestID(tree.root, /^vehicle-stop-/);
    expect(stops.map((stop) => stop.props.accessibilityLabel)).toEqual(['Miami Avenue, 1 min', 'Government Center, 2 min', 'Wilkie D Ferguson, 3 min']);
    expect(JSON.stringify(tree.toJSON())).toContain('To Government Center');
  });

  it('the Follow button starts and ends follow mode for this vehicle', async () => {
    const tree = await renderPrimitive(<VehicleSheet vehicleKey="live:transitland-1234" clock={() => NOW_S} />);
    expect(hostsByTestID(tree.root, 'vehicle-unplaced')[0]?.props.children).toBe('This vehicle is not in the timetable, so its stops are unknown');
    await press(tree, 'vehicle-follow');
    expect(FOLLOW_STORE.read()).toBe('live:transitland-1234');
    expect(hostsByTestID(tree.root, 'vehicle-follow')[0]?.props.accessibilityLabel).toBe('Following');
    await press(tree, 'vehicle-follow');
    expect(FOLLOW_STORE.read()).toBeNull();
  });
});
