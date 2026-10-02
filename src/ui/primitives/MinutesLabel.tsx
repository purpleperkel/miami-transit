import { StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { formatClockFromServiceSec, formatMinutes } from '../format';
import { TText } from './TText';

/** Beyond an hour away, a departure shows its clock time instead of a minute count (plan M6.2). */
export const CLOCK_AFTER_S = 3_600;

export type MinutesTime = {
  /** When it leaves (epoch s). */
  readonly epoch: number;
  /** Now (epoch s). */
  readonly nowS: number;
  /** The same instant as a service-day second (Departure.depS, moved by any live delay), for the clock. */
  readonly depS: number;
};

export type MinutesLabelProps = MinutesTime & {
  /** A canceled departure keeps its time, struck through. */
  readonly struck?: boolean;
  /** `minutes` is the station sheet's large figure; `headline` fits a list row. */
  readonly variant?: 'minutes' | 'headline';
  readonly testID?: string;
};

/** The words for a departure time: "Now", "4 min", or — more than 60 min away — "9:05 PM". */
export function minutesText({ epoch, nowS, depS }: MinutesTime): string {
  invariant(Number.isFinite(epoch) && Number.isFinite(nowS), 'a departure time is measured from now');
  const aheadS = epoch - nowS;
  const text = aheadS > CLOCK_AFTER_S ? formatClockFromServiceSec(depS) : formatMinutes(aheadS * 1000);
  invariant(text.length > 0, 'a departure time always reads as something');
  return text;
}

/**
 * How soon a departure leaves (plan M6.2): minutes for the next hour, then a clock time. Digits are
 * tabular, so a ticking countdown never shifts sideways.
 */
export function MinutesLabel({ struck = false, variant = 'headline', testID, ...time }: MinutesLabelProps) {
  const text = minutesText(time);
  invariant(typeof struck === 'boolean', 'a time is struck through or not');
  invariant(variant === 'minutes' || variant === 'headline', `"${variant}" is a minutes variant`);
  return (
    <TText testID={testID} variant={variant} tone={struck ? 'secondary' : 'primary'} numberOfLines={1} style={[styles.figure, struck ? styles.struck : null]}>
      {text}
    </TText>
  );
}

const styles = StyleSheet.create({
  figure: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  struck: { textDecorationLine: 'line-through' },
});
