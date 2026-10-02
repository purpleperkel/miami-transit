import { copy } from '../copy';

/** M6.1 copy: the app's words, in one place. */

describe('copy', () => {
  it('leaveIn 0 is Leave now', () => {
    expect(copy.leaveIn(0)).toBe('Leave now');
    expect(copy.leaveIn(0)).not.toContain('0');
  });

  it('leaveIn counts whole minutes and never goes negative', () => {
    expect([copy.leaveIn(1), copy.leaveIn(6)]).toEqual(['Leave in 1 min', 'Leave in 6 min']);
    expect(() => copy.leaveIn(-1)).toThrow('never negative');
    expect(() => copy.leaveIn(2.5)).toThrow('whole');
  });

  it('minutes read "<n> min"', () => {
    expect([copy.minutes(1), copy.minutes(26)]).toEqual(['1 min', '26 min']);
    expect(() => copy.minutes(-3)).toThrow('non-negative');
  });

  it('a departure row reads as one VoiceOver sentence', () => {
    const base = { line: 'Orange Line', destination: 'Airport', when: '4 min', canceled: false, source: null };
    expect(copy.departureLabel(base)).toBe('Orange Line to Airport, 4 min');
    expect(copy.departureLabel({ ...base, when: '9:05 PM', canceled: true })).toBe('Orange Line to Airport, 9:05 PM, Canceled');
    expect(copy.departureLabel({ ...base, line: null, source: 'Live' })).toBe('To Airport, 4 min, Live');
  });

  it('a live-only train with no destination reads Unscheduled train', () => {
    expect(copy.departureLabel({ line: null, destination: null, when: '5 min', canceled: false, source: null })).toBe('Unscheduled train, 5 min');
    expect(copy.departureLabel({ line: 'Omni', destination: null, when: 'Now', canceled: false, source: 'Live' })).toBe('Omni, Unscheduled train, Now, Live');
    expect(copy.unscheduledTrain).toBe('Unscheduled train');
  });

  it('the word for a canceled departure is Canceled', () => {
    expect(copy.canceled).toBe('Canceled');
    expect(Object.isFrozen(copy)).toBe(true);
  });
});

describe('copy for the stations and their sheets (M6.4, M6.5)', () => {
  it('a direction heading names every destination as alternatives', () => {
    expect([copy.toward(['Dadeland South']), copy.toward(['Palmetto', 'Miami International Airport'])]).toEqual(['To Dadeland South', 'To Palmetto or Miami International Airport']);
    expect(copy.toward(['A', 'B', 'C'])).toBe('To A, B or C');
    expect(() => copy.toward(['A', 'A'])).toThrow('once');
  });

  it('a line strip reads every line it draws', () => {
    expect([copy.lineNames(['Orange Line']), copy.lineNames(['Green Line', 'Orange Line'])]).toEqual(['Orange Line', 'Green Line and Orange Line']);
    expect(copy.lineNames(['Inner Loop', 'Omni', 'Brickell'])).toBe('Inner Loop, Omni and Brickell');
  });

  it('a Stations row reads as one VoiceOver sentence', () => {
    const base = { station: 'Brickell, Metrorail', lines: 'Green Line and Orange Line', distance: null, departures: ['Dadeland South, 4 min'] };
    expect(copy.stationRowLabel(base)).toBe('Brickell, Metrorail; Green Line and Orange Line; next to Dadeland South, 4 min');
    expect(copy.stationRowLabel({ ...base, distance: '350 m', departures: [] })).toBe('Brickell, Metrorail; Green Line and Orange Line; 350 m away; No departures in the next 3 hours');
  });
});
