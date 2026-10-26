/**
 * Launch intent for startup scenes.
 *
 * `true` only for an ordinary launch — no `--resume` target and no first
 * prompt. Startup-scene plugins (`tuiScenes.register({ startup: true })`) read
 * this through the registry's auto-open rule, so the TUI core can boot straight
 * into the chat while an opt-in plugin still owns the first frame.
 *
 * Set once per mount by the composition root before plugin rows activate; the
 * flag is process-wide because the scene registry and the composition root
 * share it, and every mount overwrites it.
 */
let freshLaunch = false

/** Composition root only: record whether this mount is an ordinary launch. */
export function setFreshLaunch(value: boolean): void {
  freshLaunch = value
}

/** True while this mount may hand its first frame to a startup scene. */
export function isFreshLaunch(): boolean {
  return freshLaunch
}
