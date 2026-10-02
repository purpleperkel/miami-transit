import { isOnWifi, swiftlyAllowed } from '../network-gate';

/**
 * mfix10 "use Swiftly only on Wi-Fi": the pure gate. On Wi-Fi = expo-network type WIFI or ETHERNET;
 * every other type (the iOS ones and the Android-only ones), a reading without a type and no reading
 * at all are off Wi-Fi (arbiter ruling: an unknown network never spends cellular data on Swiftly).
 */

describe('the network gate (mfix10): what counts as Wi-Fi', () => {
  it('only wifi and ethernet count as on wi-fi', () => {
    expect([isOnWifi({ type: 'WIFI' }), isOnWifi({ type: 'ETHERNET' })]).toEqual([true, true]);
    for (const type of ['CELLULAR', 'NONE', 'UNKNOWN', 'VPN', 'OTHER', 'BLUETOOTH', 'WIMAX', 'wifi', 'Wi-Fi', '']) {
      expect([type, isOnWifi({ type })]).toEqual([type, false]);
    }
    expect(isOnWifi({})).toBe(false);
    expect(isOnWifi({ type: undefined })).toBe(false);
    expect(isOnWifi(null)).toBe(false);
  });
});

describe('the network gate (mfix10): when Swiftly may be asked', () => {
  it('swiftly is allowed unless wi-fi only is on and the phone is off wi-fi', () => {
    const table = [
      { wifiOnly: false, onWifi: false, allowed: true },
      { wifiOnly: false, onWifi: true, allowed: true },
      { wifiOnly: true, onWifi: true, allowed: true },
      { wifiOnly: true, onWifi: false, allowed: false },
    ];
    for (const { wifiOnly, onWifi, allowed } of table) {
      expect([wifiOnly, onWifi, swiftlyAllowed({ wifiOnly, onWifi })]).toEqual([wifiOnly, onWifi, allowed]);
    }
    expect(table.filter((row) => !row.allowed)).toHaveLength(1);
  });
});
