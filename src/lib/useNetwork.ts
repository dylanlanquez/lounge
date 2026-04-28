import { useEffect, useState } from 'react';

// Subscribes to navigator.onLine + the Network Information API. Used by
// the kiosk status bar so the receptionist sees both connectivity AND
// signal quality at a glance.
//
// Browsers DO NOT expose the Wi-Fi SSID to web pages — that's a
// platform privacy/security boundary, not a Lounge limitation. The
// closest signal we can read is the Network Information API:
//
//   effectiveType  'slow-2g' | '2g' | '3g' | '4g' (round-trip + downlink classification)
//   downlink       estimated bandwidth in Mbps
//   rtt            estimated round-trip time in ms
//   saveData       true if the user's set Save Data
//
// Coverage isn't universal (older Safari often returns nothing), so the
// hook degrades cleanly to "online, no signal info" when the API isn't
// present. The status bar treats that as "show 4 bars dimmed" rather
// than crashing.

export type EffectiveType = 'slow-2g' | '2g' | '3g' | '4g' | null;

export interface NetworkState {
  online: boolean;
  effectiveType: EffectiveType;
  // Mbps. May be 0 / null on unsupported browsers.
  downlink: number | null;
  rtt: number | null;
  saveData: boolean;
  // True when the Network Information API is present at all. The bar
  // count uses this to render dimmed bars (signal info unavailable)
  // instead of pretending we know.
  supported: boolean;
}

// Map effectiveType to a 0–4 bar count. 4G is full bars, slow-2G
// drops to one. Offline = 0. We deliberately don't try to map
// downlink Mbps to bars — the effectiveType bucket already accounts
// for both bandwidth and RTT, and a clean four-step ladder is easier
// for staff to read at a glance.
export function barsFromEffectiveType(et: EffectiveType, online: boolean): 0 | 1 | 2 | 3 | 4 {
  if (!online) return 0;
  switch (et) {
    case '4g':
      return 4;
    case '3g':
      return 3;
    case '2g':
      return 2;
    case 'slow-2g':
      return 1;
    default:
      // Unknown / API not supported — show full bars dimmed so we
      // don't fake a signal level we don't actually have.
      return 4;
  }
}

interface NetworkInformation extends EventTarget {
  effectiveType?: EffectiveType;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

export function useNetwork(): NetworkState {
  const [state, setState] = useState<NetworkState>(() => initial());

  useEffect(() => {
    const nav = navigator as Navigator & {
      connection?: NetworkInformation;
      mozConnection?: NetworkInformation;
      webkitConnection?: NetworkInformation;
    };
    const conn = nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;

    const sync = () => {
      setState({
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        effectiveType: (conn?.effectiveType as EffectiveType) ?? null,
        downlink: typeof conn?.downlink === 'number' ? conn.downlink : null,
        rtt: typeof conn?.rtt === 'number' ? conn.rtt : null,
        saveData: !!conn?.saveData,
        supported: !!conn,
      });
    };

    sync();
    const onUp = () => sync();
    const onDown = () => sync();
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    if (conn) conn.addEventListener('change', sync);

    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
      if (conn) conn.removeEventListener('change', sync);
    };
  }, []);

  return state;
}

function initial(): NetworkState {
  return {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    effectiveType: null,
    downlink: null,
    rtt: null,
    saveData: false,
    supported: false,
  };
}
