/**
 * Durable projection schema for the plugin's own state.
 *
 * Hand-written rather than `zod`-based: a plugin installed with `pnpm add
 * link:<dir>` is reached through its real path, so bare imports of packages
 * that exist only in the profile's `node_modules` do not resolve. The session
 * projection registry only calls `parse` when restoring a persisted row, so a
 * validating `parse` is the whole contract.
 *
 * @module dsh-todo-discipline/schema
 */

/** @typedef {{ turnSteps: number, lastWriteStep: number | null, compactions: number }} DisciplineState */

/** Rejection message for a row that is not this plugin's state. */
function invalid(field, value) {
  return new TypeError(`todo-discipline state: ${field} must be ${value === null ? 'a number or null' : 'a number'}, got ${JSON.stringify(value)}`);
}

/**
 * Minimal schema object with the one method the projection registry uses.
 *
 * Rejects rather than repairs a malformed row: the registry treats a throw as
 * "row unusable" and refolds from `init`, which is the behaviour we want for a
 * row written by an incompatible earlier version.
 */
export const disciplineStateSchema = {
  /**
   * Validate one stored state.
   * @param value - value read from a persisted checkpoint row.
   * @returns the same value, narrowed to {@link DisciplineState}.
   * @throws TypeError when a field is missing or of the wrong type.
   */
  parse(value) {
    if (typeof value !== 'object' || value === null) throw invalid('value', value);
    const { turnSteps, lastWriteStep, compactions } = value;
    if (typeof turnSteps !== 'number' || !Number.isFinite(turnSteps)) throw invalid('turnSteps', turnSteps);
    if (lastWriteStep !== null && (typeof lastWriteStep !== 'number' || !Number.isFinite(lastWriteStep))) {
      throw invalid('lastWriteStep', lastWriteStep);
    }
    if (typeof compactions !== 'number' || !Number.isFinite(compactions)) throw invalid('compactions', compactions);
    return /** @type {DisciplineState} */ (value);
  },
};
