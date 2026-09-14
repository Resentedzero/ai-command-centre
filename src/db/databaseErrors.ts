/**
 * Classifies database errors for code that must decide whether a failure is
 * worth recording as a permanent outcome.
 *
 * drizzle wraps every driver error in a `DrizzleQueryError` whose `cause` is
 * the node-postgres error carrying the SQLSTATE `code`.
 */

/** The Postgres SQLSTATE of `error`, or its drizzle `cause`, when it has one. */
export function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Errors where retrying the same work later may succeed, so they must never be
 * turned into a permanent failure:
 *   - class 08: connection exceptions
 *   - class 40: transaction rollback (serialization failure, deadlock victim)
 *   - class 53: insufficient resources
 *   - class 57: operator intervention (query cancelled, admin shutdown)
 *   - 55P03: lock not available
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (!state) return false;
  return /^(08|40|53|57)/.test(state) || state === "55P03";
}
