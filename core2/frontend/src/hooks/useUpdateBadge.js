import { useEffect, useState } from 'react';
import { request } from '../api';

// For the tab bar's "update" dot: whether GitHub has commits that change what the NUC runs. The backend
// checks GitHub every 30 minutes by itself; this only reads its last answer, every minute.
export default function useUpdateBadge() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      request('GET', '/api/update')
        .then((u) => alive && setAvailable((u.behind ?? 0) > 0 && (u.app_changes ?? 0) > 0))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return available;
}
