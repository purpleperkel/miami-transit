import { Component, createElement, type ReactNode } from 'react';

/**
 * react-native-maps' MapView for jest, as a component a ref can hold (MapKit is native): it renders a
 * host element named 'MapView' carrying its props, and records the camera calls it receives — what
 * locate-me asks of the map. A test's labelled react-native-maps mock factory loads it.
 */

/** Every animateToRegion call the mocked MapView received: (region, duration ms). */
export const animateToRegionCalls = jest.fn();

export class MapViewMock extends Component<{ readonly children?: ReactNode }> {
  animateToRegion(...args: unknown[]): void {
    expect(args.length).toBeGreaterThan(0);
    animateToRegionCalls(...args);
    expect(animateToRegionCalls).toHaveBeenCalled();
  }

  render() {
    const element = createElement('MapView', this.props, this.props.children);
    expect(element.type).toBe('MapView');
    expect(element.props).toBeDefined();
    return element;
  }
}
