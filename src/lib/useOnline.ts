import { useEffect, useState } from 'react';

// Subscribes to the browser's online / offline events. Used by the
// kiosk status bar so the receptionist sees instantly when the tablet
// loses Wi-Fi and the app can't reach Supabase.
//
// Note: navigator.onLine reports the OS-level network state, not
// reachability of any specific host. A device "online" via captive
// portal still reads as true here. For real reachability we'd need a
// periodic health-check ping — left for a future iteration.
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  return online;
}
