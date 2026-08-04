import { describe, expect, it } from 'vitest';
import { isLiveStatus, prefixId, prefixUtteranceId } from '../session/InterpreterSession';
import type { TranscriptUpdate } from '../transcript/types';

describe('isLiveStatus', () => {
  // Catches the bug this whole feature depends on getting right: if 'connected'
  // (or either in-flight state) weren't treated as "live", a mid-session mode
  // toggle would skip tearing down the active transport before starting the
  // other one, orphaning a mic track/socket/peer connection (issue #9's core
  // acceptance criterion).
  it('treats requesting-mic, connecting, and connected as live', () => {
    expect(isLiveStatus('requesting-mic')).toBe(true);
    expect(isLiveStatus('connecting')).toBe(true);
    expect(isLiveStatus('connected')).toBe(true);
  });

  it('treats idle and error as not live', () => {
    expect(isLiveStatus('idle')).toBe(false);
    expect(isLiveStatus('error')).toBe(false);
  });
});

describe('prefixUtteranceId', () => {
  // Catches the collision bug the issue calls out explicitly: both transports mint
  // utteranceIds from OpenAI's own STT item_id, so without a per-mode namespace, an
  // id from a Realtime utterance and an id from a Cascade utterance kept in the same
  // transcript across a mode switch could collide and silently merge two unrelated
  // utterances into one entry.
  it('namespaces the utteranceId with the given mode, leaving every other field untouched', () => {
    const update: TranscriptUpdate = { utteranceId: 'item_abc123', lane: 'source', text: 'Hola', final: false };

    expect(prefixUtteranceId('realtime', update)).toEqual({
      utteranceId: 'realtime:item_abc123',
      lane: 'source',
      text: 'Hola',
      final: false,
    });
    expect(prefixUtteranceId('cascade', update)).toEqual({
      utteranceId: 'cascade:item_abc123',
      lane: 'source',
      text: 'Hola',
      final: false,
    });
  });
});

describe('prefixId', () => {
  // Catches the same cross-transport collision bug prefixUtteranceId guards against,
  // for latency reports (issue #10), which have no TranscriptUpdate shape to piggyback
  // on and need this lower-level helper directly.
  it('namespaces a bare id with the given mode', () => {
    expect(prefixId('realtime', 'turn-1')).toBe('realtime:turn-1');
    expect(prefixId('cascade', 'item_1')).toBe('cascade:item_1');
  });
});
