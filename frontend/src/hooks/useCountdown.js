import { useEffect, useState } from 'react';

/*
 * useCountdown
 *
 * Given an ISO deadline string from the server, returns seconds remaining
 * (>= 0). Returns null if `deadline` is null/undefined. Ticks once per second.
 *
 * The server is the authority on whether the question is still live; the
 * countdown is just a visual hint. We don't auto-close the question on
 * deadline expiry — the admin's "finish" action is what closes it.
 */
export function useCountdown(deadline) {
  const calc = () => {
    if (!deadline) return null;
    const t = new Date(deadline).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.round((t - Date.now()) / 1000));
  };

  const [secondsLeft, setSecondsLeft] = useState(calc);

  useEffect(() => {
    setSecondsLeft(calc());
    if (!deadline) return;
    const id = setInterval(() => setSecondsLeft(calc()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);

  return secondsLeft;
}
