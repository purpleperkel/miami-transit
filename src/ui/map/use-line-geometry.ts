import { useMemo } from 'react';

import { useScheduleDb } from '@/data/schedule-db-provider';
import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import { type LineSegment, layoutTracks, lineSegments } from './lineLayout';
import type { ZoomBucket } from './mapGeometry';

const NO_LINES: ReadonlySet<LiveLineId> = new Set();

/**
 * The lines to draw at a zoom bucket (plan M5.7), from the bundled schedule DB: each line's track
 * (line_shape → shape_point, read once by ScheduleRepo.liveNetwork), its lanes where lines share
 * track (computed once per DB), then offset for the bucket. Null while the schedule DB is opening or
 * if it failed — the map then draws no lines rather than made-up ones.
 *
 * `dimmed` must keep its identity between renders (a module constant or a memoised set), or the
 * segments are rebuilt on every render.
 */
export function useLineGeometry(bucket: ZoomBucket, dimmed: ReadonlySet<LiveLineId> = NO_LINES): readonly LineSegment[] | null {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const laid = useMemo(() => (repo === null ? null : layoutTracks(repo.liveNetwork().tracks)), [repo]);
  const segments = useMemo(() => (laid === null ? null : lineSegments(laid, bucket, dimmed)), [laid, bucket, dimmed]);
  invariant((segments === null) === (repo === null), 'lines are drawn exactly when the schedule DB is open');
  invariant(segments === null || segments.length > 0, 'an open schedule has lines to draw');
  return segments;
}
