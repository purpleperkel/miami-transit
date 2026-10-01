import { drawsLine, drawsStation, drawsVehicle, focusAfterTap, linesOfVehicle, mapEmphasis, NO_FOCUS } from '../emphasis';
import { DEFAULT_LAYERS } from '../layers';

/** M5.12 emphasis: the layers decide what is drawn; a tapped vehicle's line stays bright while the rest dim. */

describe('map emphasis (M5.12)', () => {
  it('tapping a vehicle focuses its line and dims every other; tapping it again clears', () => {
    const focus = focusAfterTap(NO_FOCUS, 'ORANGE');
    const emphasis = mapEmphasis(DEFAULT_LAYERS, focus);
    expect([...emphasis.dimmed].sort()).toEqual(['GREEN', 'MM_BRICKELL', 'MM_INNER', 'MM_OMNI', 'MM_TRUNK', 'RAIL_TRUNK']);
    expect(focusAfterTap(focus, 'ORANGE')).toBe(NO_FOCUS);
    expect(mapEmphasis(DEFAULT_LAYERS, NO_FOCUS).dimmed.size).toBe(0);
  });

  it('a train on the shared trunk focuses both lines of its trunk', () => {
    expect([...linesOfVehicle('RAIL_TRUNK')].sort()).toEqual(['GREEN', 'ORANGE', 'RAIL_TRUNK']);
    expect([...linesOfVehicle('MM_TRUNK')].sort()).toEqual(['MM_BRICKELL', 'MM_OMNI', 'MM_TRUNK']);
    const dimmed = mapEmphasis(DEFAULT_LAYERS, focusAfterTap(NO_FOCUS, 'RAIL_TRUNK')).dimmed;
    expect([dimmed.has('GREEN'), dimmed.has('ORANGE'), dimmed.has('MM_INNER')]).toEqual([false, false, true]);
  });

  it('switched-off layers are not drawn', () => {
    const noMover = mapEmphasis({ ...DEFAULT_LAYERS, mover: false }, NO_FOCUS);
    expect([drawsLine(noMover, 'GREEN'), drawsLine(noMover, 'MM_INNER'), drawsStation(noMover, 'mover')]).toEqual([true, false, false]);
    const noScheduled = mapEmphasis({ ...DEFAULT_LAYERS, scheduled: false }, NO_FOCUS);
    expect([drawsVehicle(noScheduled, { mode: 'rail', source: 'live' }), drawsVehicle(noScheduled, { mode: 'rail', source: 'scheduled' })]).toEqual([true, false]);
    const noVehicles = mapEmphasis({ ...DEFAULT_LAYERS, vehicles: false }, NO_FOCUS);
    expect([noVehicles.scheduled, drawsVehicle(noVehicles, { mode: 'rail', source: 'live' })]).toEqual([false, false]);
  });
});
