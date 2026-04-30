// Hooks for integrating widgets with the QuickPricer bus (M3.5).
//
// `useQuickPricerOpen()` exposes whether at least one QuickPricer is mounted.
// Used by ChainTable to grey out its +/− leg buttons when there's no pricer
// to receive them.

import { useEffect, useState } from 'react';
import { quickPricerStatusStream } from '../worker/busService';

export function useQuickPricerOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const status of quickPricerStatusStream()) {
          if (ctrl.signal.aborted) break;
          setOpen(status.open);
        }
      } catch {
        // Status stream errors are non-fatal — buttons stay disabled.
      }
    })();
    return () => ctrl.abort();
  }, []);
  return open;
}
