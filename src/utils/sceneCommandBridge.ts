/**
 * One-shot bridge from plugin scenes to the TUI's local command dispatcher.
 *
 * Chat owns command dispatch (it opens pickers, screens and dialogs), so the
 * scene outlet cannot build a runner itself. Chat publishes its dispatcher for
 * the lifetime of the screen; scenes receive `TuiSceneProps.runCommand`, which
 * forwards here. A scene invoking it closes first so the command's own screen
 * owns the terminal. No runner (a bare embed, or Chat unmounted) = no-op.
 */
type SceneCommandRunner = (line: string) => void

let runner: SceneCommandRunner | undefined

/** Chat: publish the dispatcher; returns the unregister disposer. */
export function setSceneCommandRunner(next: SceneCommandRunner | undefined): () => void {
  runner = next
  return () => {
    if (runner === next) runner = undefined
  }
}

/** Scene outlet: forward a command line to Chat's dispatcher. */
export function runSceneCommand(line: string): void {
  runner?.(line)
}
