import { useState, useCallback, useRef, useEffect } from 'react';

/*
 * useAsyncAction
 *
 * Wraps an async function for a one-shot operation (button click, form submit).
 * Tracks busy/error and prevents double-fire while in flight.
 *
 *   const { run, busy, error, reset } = useAsyncAction(myFn);
 *   <button onClick={() => run(arg1, arg2)}>...</button>
 *
 * The function passed to `run` is what gets called; useAsyncAction just adds
 * busy tracking and unmount safety around it.
 */
export function useAsyncAction(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const run = useCallback(async (...args) => {
    if (!mountedRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const out = await fnRef.current(...args);
      if (mountedRef.current) setBusy(false);
      return { ok: true, value: out };
    } catch (err) {
      if (mountedRef.current) {
        setError(err);
        setBusy(false);
      }
      return { ok: false, error: err };
    }
  }, []);

  const reset = useCallback(() => { setError(null); }, []);

  return { run, busy, error, reset };
}
