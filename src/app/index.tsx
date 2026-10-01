import { StyleSheet } from 'react-native';
import MapView, { type Region } from 'react-native-maps';

// Downtown Miami: Government Center sits roughly at the centre of the rail + Mover network.
const DOWNTOWN_MIAMI: Region = {
  latitude: 25.7743,
  longitude: -80.1937,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

export default function MapScreen() {
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
