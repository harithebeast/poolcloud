'use client';
import { useCallback, useSyncExternalStore } from 'react';

/** A boolean preference kept in localStorage and shared across components and tabs. */
function usePref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      window.addEventListener('storage', cb);
      window.addEventListener(`pref:${key}`, cb);
      return () => {
        window.removeEventListener('storage', cb);
        window.removeEventListener(`pref:${key}`, cb);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key) ?? String(fallback),
    () => String(fallback),
  );
  const set = useCallback(
    (v: boolean) => {
      localStorage.setItem(key, String(v));
      window.dispatchEvent(new Event(`pref:${key}`));
    },
    [key],
  );
  return [value === 'true', set];
}

export const useEncryptPref = () => usePref('pooldrive:encrypt', false);

/** 'grid' | 'list' */
export function useViewPref(): ['grid' | 'list', (v: 'grid' | 'list') => void] {
  const [list, setList] = usePref('pooldrive:view-list', false);
  return [list ? 'list' : 'grid', (v) => setList(v === 'list')];
}
