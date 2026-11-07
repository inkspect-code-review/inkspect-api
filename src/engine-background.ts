export function scheduleBackgroundWork(
  state: { generation: string; activeGeneration: string; draining: boolean; active: number },
  work: (() => Promise<void>) | undefined,
  track: (work: () => Promise<void>) => Promise<void>,
) {
  if (!work || state.draining || state.generation !== state.activeGeneration || state.active >= 2) return false;
  // track holds the engine's existing active counter until work settles, so
  // readiness and retirement account for it just like a review or index job.
  void track(work).catch(() => {});
  return true;
}
