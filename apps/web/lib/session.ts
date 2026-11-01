'use client';
import { useQuery } from '@tanstack/react-query';
import { get, setCsrfToken } from './api';
import type { User } from './types';

export interface Session {
  user: User;
  csrfToken: string;
}

/** The signed-in user. Also primes the CSRF token every state-changing request needs. */
export function useSession() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const s = await get<Session>('/auth/me');
      setCsrfToken(s.csrfToken);
      return s;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}
