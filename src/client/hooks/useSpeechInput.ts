import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal structural types for the Web Speech API. It is not in lib.dom.d.ts,
 * and only Chromium ships it (behind the `webkit` prefix), so we declare just
 * the surface we use rather than pulling in a dependency.
 */
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errors the browser raises that are not worth showing or stopping for. */
const BENIGN_ERRORS = new Set(['no-speech', 'aborted']);
const PERMISSION_ERRORS = new Set(['not-allowed', 'service-not-allowed']);

export interface UseSpeechInputOptions {
  /**
   * Called on every recognition update with everything heard since `start()`.
   * `isFinal` marks text the browser will not revise, so callers can commit it.
   */
  onTranscript: (text: string, isFinal: boolean) => void;
  lang?: string;
}

export interface SpeechInput {
  /** False when the browser has no Web Speech API (Firefox, Safari < 16.4). */
  supported: boolean;
  listening: boolean;
  /** Human-readable reason recognition stopped, or null. */
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/**
 * Dictation for the message composer. The browser hands back a growing list of
 * phrases, some still provisional, so this accumulates the settled ones and
 * re-reports them alongside the in-flight phrase — letting the caller show
 * speech as it arrives and still end up with clean, editable text.
 */
export function useSpeechInput({ onTranscript, lang }: UseSpeechInputOptions): SpeechInput {
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  // Chrome ends recognition on its own after a pause; without this we could not
  // tell that apart from the user pressing stop.
  const wantListeningRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    setListening(false);
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || wantListeningRef.current) return;

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch {
      setError('Speech recognition could not start.');
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US';

    finalRef.current = '';
    wantListeningRef.current = true;
    setError(null);

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? '';
        if (result?.isFinal) finalRef.current += text;
        else interim += text;
      }
      const combined = (finalRef.current + interim).replace(/\s+/g, ' ').trimStart();
      onTranscriptRef.current(combined, interim === '');
    };

    recognition.onerror = (event) => {
      if (BENIGN_ERRORS.has(event.error)) return;
      if (PERMISSION_ERRORS.has(event.error)) {
        setError('Microphone access was blocked. Allow it in your browser settings.');
      } else {
        setError(`Dictation stopped: ${event.error}`);
      }
      wantListeningRef.current = false;
      setListening(false);
    };

    recognition.onend = () => {
      // A pause in speech ends the run even in continuous mode, so restart
      // until the user actually asks us to stop.
      if (wantListeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          wantListeningRef.current = false;
        }
      }
      setListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      wantListeningRef.current = false;
      setError('Speech recognition could not start.');
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (wantListeningRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      try {
        recognitionRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return { supported, listening, error, start, stop, toggle };
}
