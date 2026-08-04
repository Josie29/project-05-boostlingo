/**
 * `getUserMedia` audio constraints shared by both transports' mic capture
 * (`CascadeSessionController.start()`, `RealtimeSessionController.start()`)
 * — issue #11's echo-cancellation half.
 *
 * Explicit rather than relying on browser defaults: in both modes, the
 * interpreter's own TTS/remote audio plays back through the same device the
 * mic is listening on (a laptop's built-in speaker, or headphones without a
 * boom mic positioned away from them). Without echo cancellation, that
 * output can re-enter the mic and get picked up as new "speech" — in
 * cascade mode, self-triggering a spurious barge-in via `OpenAiSttProvider`'s
 * own voice-activity detection; in Realtime mode, triggering OpenAI's
 * server-side VAD the same way. `noiseSuppression`/`autoGainControl` are
 * requested alongside it since they're part of the same "clean up what the
 * mic hands the provider" concern and cost nothing extra to ask for.
 *
 * Known limitation: `echoCancellation` is a best-effort browser/OS feature,
 * not a guarantee. On some setups — loud external speakers, no physical
 * separation between mic and speaker, some Bluetooth headsets — speaker
 * output can still re-enter the mic audibly enough to be picked up as
 * speech. There is no further client-side mitigation here (e.g. ducking or
 * muting mic input while local TTS audio is playing); see issue #11's
 * comment thread for that follow-up note.
 */
export const MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
