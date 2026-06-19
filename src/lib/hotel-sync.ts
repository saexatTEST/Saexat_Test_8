import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type HotelStateKey =
  | 'bookings'
  | 'grid'
  | 'admins'
  | 'audit'
  | 'auth-history';

interface SharedRow {
  state_key: string;
  state_data: unknown;
  version: number | string;
  updated_at: string;
}

/**
 * Single source-of-truth hook backing every shared piece of state in
 * `public.hotel_app_state`. Loads via SECURITY DEFINER RPC, listens to
 * realtime, and writes via compare-and-swap with retry.
 */
export function useSharedState<T>(key: HotelStateKey, initial: T) {
  const [data, setLocal] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  const versionRef = useRef<number>(0);
  const pendingRef = useRef<T | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writingRef = useRef(false);
  const mountedRef = useRef(true);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const { data: row, error } = await supabase.rpc('hotel_app_state_get', {
          p_key: key,
        });
        if (!mountedRef.current) return;
        if (!error && row) {
          const r = (Array.isArray(row) ? row[0] : row) as SharedRow | null;
          if (r) {
            versionRef.current = Number(r.version ?? 0);
            if (r.state_data !== null && r.state_data !== undefined) {
              setLocal(r.state_data as T);
            }
          }
        }
      } catch {
        /* keep initial; user can still work locally */
      } finally {
        if (mountedRef.current) setReady(true);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [key]);

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel(`hotel_app_state:${key}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'hotel_app_state',
          filter: `state_key=eq.${key}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as SharedRow | undefined;
          if (!row) return;
          const v = Number(row.version ?? 0);
          if (v <= versionRef.current) return;
          if (writingRef.current) return;
          versionRef.current = v;
          if (row.state_data !== null && row.state_data !== undefined) {
            setLocal(row.state_data as T);
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [key]);

  const flush = useCallback(async () => {
    if (pendingRef.current === null) return;
    let payload = pendingRef.current;
    pendingRef.current = null;
    writingRef.current = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: row, error } = await supabase.rpc('hotel_app_state_cas', {
          p_key: key,
          p_data: payload as unknown as object,
          p_expected_version: versionRef.current,
        });
        if (error) break;
        const r = (Array.isArray(row) ? row[0] : row) as SharedRow | null;
        if (!r) break;
        const newV = Number(r.version ?? 0);
        const won = newV === versionRef.current + 1;
        versionRef.current = newV;
        if (won) break;
        // Conflict: adopt server state and stop. Caller's next action will
        // run against the latest data thanks to functional setData.
        if (r.state_data !== null && r.state_data !== undefined) {
          setLocal(r.state_data as T);
        }
        break;
      }
    } catch {
      /* swallow; next call will retry */
    } finally {
      writingRef.current = false;
      if (pendingRef.current !== null) {
        // Something queued during flush — schedule another.
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => {
          void flush();
        }, 50);
      }
    }
  }, [key]);
  const setData = useCallback(
    (updater: (prev: T) => T) => {
      setLocal((prev) => {
        const next = updater(prev);
        if (Object.is(next, prev)) return prev;
        pendingRef.current = next;
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => {
          void flush();
        }, 150);
        return next;
      });
    },
    [flush],
  );

  return { data, setData, ready };
}
