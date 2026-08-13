import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { readProposedPaneFitDimensions } from '@/lib/pane-manager/pane-fit'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from '../../../../shared/terminal-mode-reset-profiles'

/**
 * The gap is answered once, at the head of the replay: CAN has to precede the
 * first ESC or the truncated control string it exists to discard gets committed
 * instead. Later writes follow well-formed snapshot payloads, so there is
 * nothing left to abort by then.
 */
function abortGapBeforeFirstWrite(writes: string[]): string[] {
  return [`${ABORT_TRUNCATED_CONTROL_STRING}${writes[0]}`, ...writes.slice(1)]
}

/**
 * Shared guards and write choreography for painting a main-model snapshot into
 * a (possibly fresh) xterm. One source for the reattach/hidden-restore paint
 * paths so their dimension guards and alt-screen branches cannot drift.
 */

/** True only for finite positive numeric cols/rows — Infinity/NaN/undefined
 *  from a malformed snapshot must degrade to "no resize", never reach
 *  terminal.resize(). */
export function hasPositiveTerminalDimensions(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    cols > 0 &&
    rows > 0
  )
}

/** Narrowing form of hasPositiveTerminalDimensions for optional-typed payloads. */
export function resolvePositiveTerminalDimensions(
  cols: unknown,
  rows: unknown
): { cols: number; rows: number } | null {
  return hasPositiveTerminalDimensions(cols, rows)
    ? { cols: cols as number, rows: rows as number }
    : null
}

/**
 * The column count the post-replay fit will land on. Why not terminal.cols: a
 * pane that has not been fitted yet still reads xterm's 80-column default, so
 * comparing against it would drop frames whose width actually matches the
 * container. Returns undefined when the pane cannot be measured, so replay can
 * retain the frame at its capture grid until a final fit exists.
 */
export function readProposedTerminalCols(pane: ManagedPane): number | undefined {
  return readProposedPaneFitDimensions(pane)?.cols
}

export function shouldSkipAltFrameForWidthMismatch(
  snapshotCols: number | undefined,
  targetCols: number | undefined
): boolean {
  if (typeof snapshotCols !== 'number' || !Number.isFinite(snapshotCols) || snapshotCols <= 0) {
    return false
  }
  if (typeof targetCols !== 'number' || !Number.isFinite(targetCols) || targetCols <= 0) {
    // Keep the frame at its capture grid until a real fit can replace that grid.
    return false
  }
  // Fixed-grid alt rows clip at narrower columns; normal history remains reflowable.
  return snapshotCols > targetCols
}

/**
 * Ordered replay writes for a main-model snapshot, including the alt-screen
 * choreography: main strips the `?1049h` marker when splitting scrollbackAnsi
 * from an alt frame, so the restorer owns the transition — rebuild the normal
 * buffer while on it, then paint the alt frame clean. Callers write these
 * before their post-replay reset/escape-tail sequences.
 *
 * `skipAltFrame` drops only the frame paint, never the buffer choreography or
 * scrollback or mode rehydration: the alt buffer is still entered and cleared
 * so the caller's SIGWINCH lands on a clean screen the application repaints.
 */
export function buildMainModelSnapshotReplayWrites(
  snapshot: {
    data: string
    /** Live state that can be restored without an alternate-screen frame. */
    frameRestoreAnsi?: string
    alternateScreen?: boolean
    scrollbackAnsi?: string
  },
  options: { skipAltFrame?: boolean; paneOnAlternateScreen: boolean }
): string[] {
  const { paneOnAlternateScreen } = options
  const normalPrologue = buildSnapshotReplayPrologue({
    targetAlternateScreen: false,
    paneOnAlternateScreen
  })
  // The alt payload always follows a hop through the normal buffer in the split
  // branch, so its own switch is judged from there, not from where we started.
  const altPrologue = (fromAlternateScreen: boolean): string =>
    buildSnapshotReplayPrologue({
      targetAlternateScreen: true,
      paneOnAlternateScreen: fromAlternateScreen
    })
  if (!snapshot.alternateScreen) {
    // Why: \x1b[3J wipes xterm scrollback; safe here because a normal-buffer
    // snapshot carries its own history in data (mirrors pty-transport.ts).
    // Why the baseline: a replay only happens because renderer-bound bytes were
    // dropped, so every piece of state the drop interrupted is unknown, and the
    // payload is diffed against a default terminal (STA-4042).
    // Why ?1049l: the gap can eat the TUI's own exit sequence, leaving the
    // renderer on the alt screen while the model already moved back to normal.
    // Without it the whole restored history paints into the alt buffer — it
    // looks right, but normal-buffer scrollback stays empty and the content
    // disappears the next time anything switches buffers. Not a no-op when
    // already on normal — only the buffer swap is skipped, while restoreCursor
    // and the kitty flag swap still run — which is why the baseline brackets it.
    return abortGapBeforeFirstWrite([normalPrologue, snapshot.data])
  }
  // Older snapshot producers do not expose the mode/frame boundary. Keep their
  // composed data rather than dropping terminal modes together with the frame.
  const altFrame =
    options.skipAltFrame && snapshot.frameRestoreAnsi !== undefined
      ? [snapshot.frameRestoreAnsi]
      : [snapshot.data]
  if (snapshot.scrollbackAnsi !== undefined) {
    // Why: main serializes normal + alt buffers separately; rebuild normal
    // while active, then return to a clean alt frame.
    // Why a prologue per payload: each is diffed against the baseline, and the
    // margins are per buffer, so each buffer is grounded after its own switch.
    // scrollbackAnsi used to replay BEFORE any reset at all, so the normal-buffer
    // history inherited the stale state even though the alt frame after it did
    // not (STA-4042).
    return abortGapBeforeFirstWrite([
      normalPrologue,
      snapshot.scrollbackAnsi,
      altPrologue(false),
      ...altFrame
    ])
  }
  // Why the explicit clear: xterm's own `FIXME: implement DECSCNM, 1049 should
  // clear altbuffer` (InputHandler.ts:1925) — `?1049h` does not clear the alt
  // buffer, and it is skipped entirely when already on it, so the pre-hide
  // frame would bleed through the snapshot's blank cells (spares normal-buffer
  // scrollback).
  return abortGapBeforeFirstWrite([altPrologue(paneOnAlternateScreen), ...altFrame])
}
