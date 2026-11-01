export interface HeadroomPolicy {
  /** Percent of an account's limit kept free. */
  percent: number;
  /** Absolute floor in bytes. */
  minBytes: number;
}

export interface AccountQuotaView {
  limit: number;
  usage: number;
  /** Bytes promised to in-flight uploads. */
  reserved: number;
}

export function headroomBytes(limit: number, policy: HeadroomPolicy): number {
  return Math.max(Math.ceil((limit * policy.percent) / 100), policy.minBytes);
}

/** Bytes that may still be newly placed on an account. Never negative. */
export function availableBytes(account: AccountQuotaView, policy: HeadroomPolicy): number {
  const free =
    account.limit - account.usage - account.reserved - headroomBytes(account.limit, policy);
  return Math.max(0, free);
}

export interface PlacementCandidate {
  accountId: string;
  available: number;
}

/** Pluggable policy: pick the account for the next blob. Return null if none can hold it. */
export interface PlacementStrategy {
  choose(candidates: readonly PlacementCandidate[], bytes: number): string | null;
}

/** Default: the account with the most available space (ties broken by id for determinism). */
export class MostFreeSpaceStrategy implements PlacementStrategy {
  choose(candidates: readonly PlacementCandidate[], bytes: number): string | null {
    let best: PlacementCandidate | null = null;
    for (const c of candidates) {
      if (c.available < bytes) continue;
      if (
        !best ||
        c.available > best.available ||
        (c.available === best.available && c.accountId < best.accountId)
      ) {
        best = c;
      }
    }
    return best?.accountId ?? null;
  }
}
