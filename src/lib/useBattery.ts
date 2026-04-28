import { useEffect, useState } from 'react';

// Minimal subset of the Battery Status API we actually use. The full type
// isn't in the standard lib so we declare just enough.
interface BatteryManager extends EventTarget {
  level: number; // 0..1
  charging: boolean;
}

export interface BatteryState {
  // 0..1, or null when the API isn't supported / hasn't resolved yet.
  level: number | null;
  charging: boolean | null;
  // True when navigator.getBattery() exists and resolved successfully.
  // The status bar uses this to decide whether to render the indicator
  // at all, so a desktop browser without battery info doesn't show a
  // misleading "—%" value.
  supported: boolean;
}

// Subscribes to the device battery and re-renders on level / charging
// changes. Used by the kiosk status bar so the receptionist sees live
// battery info while the system status bar is hidden.
export function useBattery(): BatteryState {
  const [state, setState] = useState<BatteryState>({
    level: null,
    charging: null,
    supported: true, // optimistic until we know otherwise
  });

  useEffect(() => {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManager>;
    };
    if (typeof nav.getBattery !== 'function') {
      setState({ level: null, charging: null, supported: false });
      return;
    }

    let battery: BatteryManager | null = null;
    let cancelled = false;
    const sync = () => {
      if (!battery) return;
      setState({
        level: battery.level,
        charging: battery.charging,
        supported: true,
      });
    };

    nav
      .getBattery()
      .then((b) => {
        if (cancelled) return;
        battery = b;
        sync();
        b.addEventListener('levelchange', sync);
        b.addEventListener('chargingchange', sync);
      })
      .catch(() => {
        if (!cancelled) {
          setState({ level: null, charging: null, supported: false });
        }
      });

    return () => {
      cancelled = true;
      if (battery) {
        battery.removeEventListener('levelchange', sync);
        battery.removeEventListener('chargingchange', sync);
      }
    };
  }, []);

  return state;
}

export type BatteryTone = 'ok' | 'low' | 'critical';

// Maps a battery percentage (0-100, integer) to a visual urgency tone.
// Thresholds match Apple's iOS conventions so receptionists see a
// familiar pattern: amber at 25% (lead time to plug in), red at 10%
// (act-now critical).
export function batteryTone(percent: number | null): BatteryTone {
  if (percent === null) return 'ok';
  if (percent <= 10) return 'critical';
  if (percent <= 25) return 'low';
  return 'ok';
}
