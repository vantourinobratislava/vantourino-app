import { useEffect, useRef, useState, useCallback } from 'react';

/*
 * usePolling
 *
 * Periodically calls `fetcher` and stores the result. Cancellation-safe:
 * if `fetcher` returns after the component unmounts (or after a newer call
 * supersedes it), the result is dropped.
 *
 * Returns { data, loading, error, refetch, stale }.
 *  - `loading` is true only on the very first fetch
 *  - `stale` is true while a background refresh is in flight (useful for a
 *    small "updating…" indicator without flashing the whole screen)
 *
 * `enabled=false` pauses polling without unmounting.
 */
export function usePolling(fetcher, { intervalMs = 3000, enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);

  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  const callId = useRef(0);
  const timerRef = useRef(null);

  const tick = useCallback(async ({ background = false } = {}) => {
    const myCall = ++callId.current;
    if (background) setStale(true);
    try {
      const result = await fetcherRef.current();
      if (myCall !== callId.current) return; // superseded
      setData(result);
      setError(null);
    } catch (err) {
      if (myCall !== callId.current) return;
      setError(err);
    } finally {
      if (myCall === callId.current) {
        setLoading(false);
        setStale(false);
      }
    }
  }, []);

  // Reset and start polling when enabled or deps change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    setLoading(true);
    setData(null);
    setError(null);
    tick({ background: false });
    timerRef.current = setInterval(() => tick({ background: true }), intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [enabled, intervalMs, tick, ...deps]);

  const refetch = useCallback(() => tick({ background: true }), [tick]);

  return { data, loading, error, refetch, stale };
}
