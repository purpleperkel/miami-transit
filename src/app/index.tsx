import { StyleSheet } from 'react-native';
import MapView, { type Region } from 'react-native-maps';

import { invariant } from '@/lib/invariant';

// Downtown Miami: Government Center sits roughly at the centre of the rail + Mover network.
const DOWNTOWN_MIAMI: Region = {
  latitude: 25.7743,
  longitude: -80.1937,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

export default function MapScreen() {
  // MKMapView throws on an invalid region, so the initial region's contract is checked first.
  invariant(
    Math.abs(DOWNTOWN_MIAMI.latitude) <= 90 && Math.abs(DOWNTOWN_MIAMI.longitude) <= 180,
    'the initial region centres on a real coordinate',
  );
  invariant(
    DOWNTOWN_MIAMI.latitudeDelta > 0 && DOWNTOWN_MIAMI.longitudeDelta > 0,
    'the initial region spans a visible area',
  );
  return (
    <MapView
      style={StyleSheet.absoluteFill}
      initialRegion={DOWNTOWN_MIAMI}
      mapType="mutedStandard"
      showsPointsOfInterests={false}
      showsBuildings={false}
      pitchEnabled={false}
    />
  );
}
