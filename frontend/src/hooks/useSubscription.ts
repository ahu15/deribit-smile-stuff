import { useEffect, useRef, useState } from 'react';
import { subscribeRemote } from '../worker/hrtWorker';

export function useSubscription<T>(service: string, params?: unknown) {
  const [latest, setLatest] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const item of subscribeRemote(service, paramsRef.current)) {
          if (ctrl.signal.aborted) break;
          setLatest(item as T);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => ctrl.abort();
  }, [service]); // eslint-disable-line react-hooks/exhaustive-deps

  return { latest, error };
}
