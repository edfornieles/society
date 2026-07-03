"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bumpTurn, addCanonLines, addOpenThreads, createEmptyBible } from "@/lib/societyBible";
import { useSociety } from "./SocietyContext";
import { saveGame, listGames, deleteGame, getGame } from "@/lib/gameHistory";
import { recapPrompt, finalBreakdownPrompt, recapNarrationPrompt, recapSlideshowPrompt, Playfulness } from "@/lib/prompts";
import { safeJsonParse } from "@/lib/guardrails";
import { normalizeCoreValueUtterance, extractCoreTopicPhrase } from "@/lib/coreValueNormalize";
import { isSpuriousUserTranscript } from "@/lib/transcriptGuards";
import { withBase } from "@/lib/basePath";
import type { GeneratedImage } from "@/lib/generatedImage";
import {
  isWeakCoreValueLabel,
  buildClarifyRepeatInstructions,
  hasConcreteFirstImageAnchor,
  buildGuidedTurnInstructions,
  buildCoreValueAcceptedInstructions,
  buildRulesThenCoreInstructions,
  buildResumeInstructions,
  buildCorrectionAckInstructions,
  parseUserCorrectionLabel,
  WANTS_RULES_PATTERN,
  WRAP_UP_PATTERN,
  pickSessionTitle,
  getCoreChoice,
  OUTPUT_FORMAT_GUARD,
  sanitizeModelReply,
  looksLikeUsableReply,
  compactCanonSummary,
} from "@/lib/gameEngine";

type ChatLine = { at: string; role: "assistant" | "user" | "sys"; text: string };

type BibleUpdate = {
  addCanon: string[];
  addOpenThreads: string[];
  contradictionsFound: string[];
  reconciliationOptions: string[];
};

const DEFAULT_64BIT_STYLE_GUIDE =
  "64-bit retro pixel art (late PS1/N64-era). Crisp pixels with richer detail, broader palette, subtle dithering, strong silhouettes, readable shapes. Cozy cinematic framing translated into pixel art. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

const GREETING_TEXT =
  "Hi — I'm your Society co-creator; we're playing the Society worldbuilding game together.\n\nWhat's the most important thing in this society? Everything else will follow from it.";

/** Encode mono Float32 PCM chunks as a 16-bit WAV blob (what /api/transcribe
 *  uploads). Raw PCM lets capture include pre-roll audio from BEFORE the VAD
 *  triggered — impossible with MediaRecorder, which only records from start(). */
function encodeWavFromPcm(chunks: Float32Array[], sampleRate: number): Blob {
  let len = 0;
  for (const c of chunks) len += c.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + len * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, "data");
  dv.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Split into sentence-ish chunks for pipelined TTS (see speak() below). */
function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]+(\s+|$)/g) ?? [trimmed];
  const sentences = parts.map((s) => s.trim()).filter(Boolean);
  // Merge stray short fragments (e.g. a trailing clause with no terminal
  // punctuation) into the previous sentence rather than firing a near-empty
  // TTS request for a couple of words.
  const merged: string[] = [];
  for (const s of sentences) {
    if (merged.length > 0 && s.split(/\s+/).length <= 3) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${s}`;
    } else {
      merged.push(s);
    }
  }
  return merged.length ? merged : [trimmed];
}

/**
 * Pull the COMPLETE sentences out of a growing stream buffer, returning them
 * plus the still-incomplete remainder to carry forward. Used to fire TTS on
 * each finished sentence while the LLM is still generating the rest.
 */
function drainSentences(buffer: string): { sentences: string[]; rest: string } {
  const lastPunct = Math.max(buffer.lastIndexOf("."), buffer.lastIndexOf("!"), buffer.lastIndexOf("?"));
  if (lastPunct === -1) return { sentences: [], rest: buffer };
  const complete = buffer.slice(0, lastPunct + 1);
  const rest = buffer.slice(lastPunct + 1);
  return { sentences: splitIntoSentences(complete), rest };
}

/**
 * OpenVoiceConsole — the uncensored, self-hosted voice pipeline: Whisper (STT,
 * OpenAI, already used elsewhere) -> OpenRouter open-weight LLM (/api/voice-turn)
 * -> Pocket-TTS (local, free, Kyutai). Distinct from VoiceConsoleV2, which uses
 * OpenAI's Realtime API end-to-end and is subject to OpenAI's own moderation
 * layer that prompting alone can't relax. Shares its game-engine plumbing with
 * TextConsoleV2 — only the model call target and the addition of TTS
 * playback + auto-listen loop differ.
 */
export function OpenVoiceConsole({
  showSettings,
  onToggleSettings,
  startLabel,
  resumeMode,
  playfulness,
  setPlayfulness,
  autoImages,
  setAutoImages,
  autoEveryTurns,
  setAutoEveryTurns,
  newGameRef,
}: {
  showSettings: boolean;
  onToggleSettings: () => void;
  startLabel: string;
  resumeMode: "new" | "continue" | "recap";
  playfulness: Playfulness;
  setPlayfulness: (v: Playfulness) => void;
  autoImages: boolean;
  setAutoImages: (v: boolean) => void;
  autoEveryTurns: number;
  setAutoEveryTurns: (v: number) => void;
  // GameShell fills this with the console's "start a fresh game" fn, so the
  // New Game nav button can call it DIRECTLY inside its React click (identical
  // to the Start button) instead of via a raw window event whose indirection
  // made activation unreliable on the first click.
  newGameRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const {
    bible,
    setBible,
    images,
    setImages,
    summary,
    setSummary,
    finalRecord,
    setFinalRecord,
    setHistory,
    sessionId,
    setSessionId,
  } = useSociety();

  const [active, setActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [recapPlaying, setRecapPlaying] = useState(false);
  const recapSkipRef = useRef(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageStyleGuide, setImageStyleGuide] = useState<string>(DEFAULT_64BIT_STYLE_GUIDE);
  const [lastSaveAt, setLastSaveAt] = useState<string>("");
  const [lastSaveTitle, setLastSaveTitle] = useState<string>("");
  const [editTitle, setEditTitle] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState("");
  const [ttsError, setTtsError] = useState("");

  // Continuous raw-PCM capture (replaces MediaRecorder). The tap runs the whole
  // session; while idle it keeps only a ~400ms rolling pre-roll, and during a
  // turn it accumulates everything. This is what preserves the FIRST syllable:
  // the VAD needs ~120ms of sustained speech before it triggers, and a recorder
  // started at that moment amputated every word's head ("robotics" → "botox").
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const pcmProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmSilentGainRef = useRef<GainNode | null>(null);
  const pcmSampleRateRef = useRef<number>(0);
  // Speculative STT (see VAD_STT_SPECULATE_MS): the transcription fired during
  // the end-of-turn hold. endCapture consumes it instead of transcribing fresh.
  const specSttPromiseRef = useRef<Promise<string> | null>(null);
  const specSttFiredRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  // One AudioContext shared by mic-VAD analysis AND TTS-playback analysis,
  // created/unlocked on the Start button click (the one guaranteed direct
  // user gesture) and kept alive for the whole session. A context spun up
  // later with no gesture of its own — which is what every auto-triggered
  // recording after that first click would be — can be created "suspended"
  // in a lot of browsers (Safari especially), and a suspended context's
  // whole node graph — analyser AND the PCM capture tap — never sees a
  // single real sample, which looks exactly like "it can't hear me" rather
  // than an outright error.
  const sharedAudioContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // The mic stream + its analyser are opened ONCE on Start and kept alive for
  // the whole session (full-duplex: always listening, even while the model
  // speaks, so the user can talk over it). monitorRafRef drives the single
  // continuous VAD loop; the old per-utterance open/close is gone.
  const monitorRafRef = useRef<number | null>(null);
  // Guards reacquireMic against overlapping runs (track.onended firing while a
  // reacquire is already in flight would double-open the mic).
  const micReacquiringRef = useRef(false);
  const hasSpokenRef = useRef(false);
  const silenceSinceRef = useRef<number | null>(null);
  const speechOnsetSinceRef = useRef<number | null>(null);
  const bargeSinceRef = useRef<number | null>(null);
  const captureStartedAtRef = useRef<number | null>(null);
  const noiseFloorRef = useRef<number>(0.012);
  const calibrationSamplesRef = useRef<number[]>([]);
  const calibrationStartRef = useRef<number | null>(null);
  const calibrationDoneRef = useRef<boolean>(false);
  // Bumped every time a new reply starts speaking; an in-flight speak() loop
  // and its playBlob awaits check it and bail the instant they're superseded
  // (barge-in, new turn), so stale audio never keeps playing.
  const speakTokenRef = useRef(0);
  // Aborts the in-flight LLM token stream on barge-in / new turn so we stop
  // generating (and paying for) a reply the user just interrupted.
  const streamAbortRef = useRef<AbortController | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRafRef = useRef<number | null>(null);
  const startModeRef = useRef<"new" | "continue" | "recap">("new");
  const bibleRef = useRef(bible);
  const imagesRef = useRef(images);
  const summaryRef = useRef(summary);
  const sessionIdRef = useRef(sessionId);
  const lastSessionIdRef = useRef(sessionId);
  const autosaveTimerRef = useRef<number | null>(null);
  const lastAutoImageTurnRef = useRef<number>(0);
  const lastAutoImageFailureTurnRef = useRef<number>(-1);
  // True only once the player has actually taken a turn IN THE CURRENT session.
  // Without this, auto-resuming a saved game (active=true, loaded turnCount>0,
  // existing images) instantly fired the per-turn image effect — generating
  // images while the player is just sitting on the recap, not playing.
  const playedThisSessionRef = useRef(false);
  // True while start() is spinning up a session. The session-change effect must
  // NOT tear down (setActive false) during this window — start() legitimately
  // changes sessionId, and on a fresh mount that change can otherwise race the
  // effect and deactivate the game we just started (New Game "does nothing").
  const startingRef = useRef(false);
  const onboardingPhaseRef = useRef<"pre_core" | "done">("done");
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  // Synchronous mirrors of the four flags that gate the always-on audio loop.
  // CRITICAL: these MUST be updated in the same tick as the setState call, not
  // via a useEffect — the continuous monitor loop and the barge-in / capture
  // transitions read these refs immediately after flipping a flag (e.g.
  // "stop speaking, now start capturing"). A useEffect mirror lags by a render
  // commit, so the loop would read the OLD value and silently refuse to
  // transition — which is exactly the "it can't hear me, stuck on Waiting"
  // bug. The set*Sync helpers below keep ref and state in lockstep.
  const activeRef = useRef(active);
  const sendingRef = useRef(sending);
  const speakingRef = useRef(speaking);
  const recordingRef = useRef(recording);

  const setActiveSync = (v: boolean) => {
    activeRef.current = v;
    setActive(v);
  };
  const setSendingSync = (v: boolean) => {
    sendingRef.current = v;
    setSending(v);
  };
  const setSpeakingSync = (v: boolean) => {
    speakingRef.current = v;
    setSpeaking(v);
  };
  const setRecordingSync = (v: boolean) => {
    recordingRef.current = v;
    setRecording(v);
  };

  useEffect(() => {
    bibleRef.current = bible;
  }, [bible]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    startModeRef.current = resumeMode;
  }, [resumeMode]);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const existing = await getGame(sessionId);
      if (existing?.title) setEditTitle(existing.title);
    })().catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (!lastSessionIdRef.current) {
      lastSessionIdRef.current = sessionId;
      return;
    }
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      // A start() in progress changes sessionId on purpose — don't treat that
      // as "the user switched sessions" and tear the new game down.
      if (startingRef.current) return;
      cancelSpeech();
      closeMic();
      setActiveSync(false);
      setChat([]);
      historyRef.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight });
  }, [chat]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("society-image-busy", { detail: { busy: imageBusy } }));
  }, [imageBusy]);

  const addLine = (role: ChatLine["role"], text: string) => {
    setChat((prev) => [...prev, { at: new Date().toLocaleTimeString(), role, text }]);
  };

  // Real turn-by-turn history, sent to the model alongside a much shorter
  // per-turn system prompt (see buildGuidedTurnInstructions) instead of
  // re-deriving "what's been said" into the instructions every call. This is
  // what lets the model track the world the way any chat model tracks
  // context, rather than getting re-briefed from scratch each turn. Capped
  // to a rolling window so token cost doesn't grow unbounded with session length.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  // 12 messages = 6 recent exchanges. Enough for local continuity, but short
  // enough that older turns flush quickly — on long/edgy sessions the
  // open-weight model can drift (garbled tokens, language slips), and a
  // shorter window stops that drift from compounding by keeping stale/degraded
  // assistant turns from lingering in context. The per-turn system prompt
  // still carries the core value, so grounding isn't lost.
  const MAX_HISTORY_MESSAGES = 12;
  const pushHistory = (role: "user" | "assistant", content: string) => {
    const text = content.trim();
    if (!text) return;
    historyRef.current = [...historyRef.current, { role, content: text }].slice(-MAX_HISTORY_MESSAGES);
  };

  const ensureAudioContext = async (): Promise<AudioContext> => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!sharedAudioContextRef.current) {
      sharedAudioContextRef.current = new AudioCtx();
    }
    const ctx = sharedAudioContextRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    return ctx;
  };

  const drawWaveBaseline = () => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.clearRect(0, 0, width, height);
    const barCount = 36;
    const gap = 2;
    const barWidth = Math.max(4, Math.floor(width / barCount) - gap);
    const totalWidth = barCount * barWidth + (barCount - 1) * gap;
    const offsetX = Math.max(0, Math.floor((width - totalWidth) / 2));
    const midY = Math.floor(height / 2);
    const baseHeight = 6;
    for (let i = 0; i < barCount; i += 1) {
      const x = offsetX + i * (barWidth + gap);
      const y = midY - baseHeight;
      ctx2d.fillStyle = "#d41a12";
      ctx2d.fillRect(x, y, barWidth, baseHeight * 2);
      ctx2d.fillStyle = "rgba(255, 200, 190, 0.6)";
      ctx2d.fillRect(x, midY + baseHeight - 4, barWidth, 4);
    }
  };

  useEffect(() => {
    drawWaveBaseline();
  }, []);

  /** Paint one frame of reactive bars from an analyser's frequency data. */
  const paintBars = (analyser: AnalyserNode, dataArray: Uint8Array<ArrayBuffer>) => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    analyser.getByteFrequencyData(dataArray);
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.clearRect(0, 0, width, height);
    const barCount = 36;
    const gap = 2;
    const barWidth = Math.max(4, Math.floor(width / barCount) - gap);
    const totalWidth = barCount * barWidth + (barCount - 1) * gap;
    const offsetX = Math.max(0, Math.floor((width - totalWidth) / 2));
    const midY = Math.floor(height / 2);
    const activeCount = 34;
    const centerOffset = (barCount - 1) / 2;
    const radius = Math.max(1, activeCount / 2);
    for (let i = 0; i < barCount; i += 1) {
      const distance = Math.abs(i - centerOffset);
      const sampleIndex = Math.min(dataArray.length - 1, Math.floor((distance / radius) * (dataArray.length - 1)));
      const v = dataArray[sampleIndex] / 255;
      const isActive = distance <= radius;
      const weight = Math.max(0, 1 - distance / radius);
      const baseHeight = 6;
      const barHeight = Math.max(baseHeight, Math.floor(v * weight * height));
      const drawHeight = isActive ? barHeight : baseHeight;
      const x = offsetX + i * (barWidth + gap);
      const y = midY - drawHeight;
      ctx2d.fillStyle = "#d41a12";
      ctx2d.fillRect(x, y, barWidth, drawHeight * 2);
      ctx2d.fillStyle = "rgba(255, 200, 190, 0.6)";
      ctx2d.fillRect(x, midY + drawHeight - 4, barWidth, 4);
    }
  };

  /** Drives the waveform canvas from the TTS playback analyser while speaking. */
  const runWaveformLoop = (analyser: AnalyserNode) => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      if (waveRafRef.current === null) return; // loop was cancelled
      paintBars(analyser, dataArray);
      waveRafRef.current = requestAnimationFrame(draw);
    };
    waveRafRef.current = requestAnimationFrame(draw);
  };

  const stopWaveformLoop = () => {
    if (waveRafRef.current !== null) {
      cancelAnimationFrame(waveRafRef.current);
      waveRafRef.current = null;
    }
    drawWaveBaseline();
  };

  /**
   * Same shape as TextConsoleV2's askModel, routed to the uncensored
   * open-weight model. Conversational (non-json) calls get an explicit
   * brevity directive appended: TTS here is non-streaming and generation
   * time scales with reply length, so a short reply isn't just nicer pacing
   * for spoken conversation — it's the main lever against dead-air latency.
   * (/api/voice-turn also caps max_tokens tighter for the same reason; this
   * keeps the model from getting abruptly cut off mid-sentence at that cap.)
   */
  const callVoiceTurn = async (
    instructions: string,
    json: boolean,
    history?: { role: "user" | "assistant"; content: string }[],
    maxTokens?: number
  ): Promise<string> => {
    const r = await fetch(withBase("/api/voice-turn"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions, json, history, maxTokens }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.text) {
      throw new Error(String(data?.error ?? `Voice turn failed (${r.status})`));
    }
    return String(data.text);
  };

  // This uncensored open-weight model, unlike OpenAI's, occasionally "leaks"
  // meta-instructional text into its reply instead of just answering
  // in-character (see sanitizeModelReply/OUTPUT_FORMAT_GUARD in gameEngine.ts).
  // Sanitize every non-JSON reply and retry once with a sharper reminder if
  // nothing usable survives, rather than speaking/displaying raw garbage.
  //
  // opts.brief (default true) appends the "keep it to 2 sentences" voice
  // directive — right for a conversational fallback, but WRONG for a recap or
  // resume, which are multi-sentence chronicles. opts.maxTokens lifts the
  // server's tight 220-token turn cap so those longer replies don't truncate.
  const askModel = async (
    instructions: string,
    json = false,
    opts: { brief?: boolean; maxTokens?: number } = {}
  ): Promise<string> => {
    if (json) return callVoiceTurn(instructions, true, undefined, opts.maxTokens);
    const brief = opts.brief ?? true;
    const brevity = brief
      ? "\n\nVOICE MODE — CRITICAL: this is spoken aloud, not read. Keep your ENTIRE reply to 2 short sentences maximum. Brevity matters far more here than in text."
      : "";
    const finalInstructions = `${instructions}${brevity}\n\n${OUTPUT_FORMAT_GUARD}`;
    const first = sanitizeModelReply(await callVoiceTurn(finalInstructions, false, historyRef.current, opts.maxTokens));
    if (looksLikeUsableReply(first)) return first;
    const retryInstructions = `${finalInstructions}\n\nYour previous attempt was invalid — it contained meta-commentary, formatting, or a garbled fragment instead of a clean in-character line. Try again: output ONLY the spoken line, nothing else.`;
    const retry = sanitizeModelReply(await callVoiceTurn(retryInstructions, false, historyRef.current, opts.maxTokens));
    return looksLikeUsableReply(retry) ? retry : first || retry;
  };

  const requestTtsBlob = async (text: string): Promise<Blob> => {
    const r = await fetch(withBase("/api/tts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(String(data?.error ?? "TTS failed"));
    }
    return await r.blob();
  };

  // Pocket-TTS is a single local process — a one-off hiccup (dev-server hot
  // reload, a request landing mid-restart) is transient. One retry recovers
  // silently instead of permanently dropping that sentence's audio.
  const fetchTtsBlob = async (text: string): Promise<Blob | null> => {
    try {
      const blob = await requestTtsBlob(text);
      setTtsError("");
      return blob;
    } catch {
      try {
        const blob = await requestTtsBlob(text);
        setTtsError("");
        return blob;
      } catch (e) {
        setTtsError(String((e as Error)?.message ?? "TTS failed"));
        return null;
      }
    }
  };

  const playBlob = async (blob: Blob, token: number): Promise<void> => {
    // Superseded before we even start (barge-in / new turn landed while the
    // next sentence's audio was still being fetched) — don't play stale audio.
    if (token !== speakTokenRef.current) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    playbackAudioRef.current = audio;
    let settled = false;
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      stopWaveformLoop();
      resolveDone();
    };
    audio.onended = done;
    audio.onerror = done;
    // cancelSpeech() pauses this element to interrupt the model; pause does NOT
    // fire "ended", so without this the await below would hang forever.
    audio.onpause = done;
    try {
      // Drive the waveform from the AI's own speech. A MediaElementSource
      // takes over the element's audio routing, so it MUST be reconnected
      // through to destination or playback goes silent.
      const ctx = await ensureAudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      runWaveformLoop(analyser);
    } catch {
      // If the Web Audio graph setup fails for any reason, playback still
      // works via the plain <audio> element — just no waveform reactivity.
    }
    audio.play().catch(done);
    return donePromise;
  };

  /** Hard-stop whatever audio is currently playing. Critical for the
   *  single-voice invariant: bumping the speak token stops FUTURE sentences,
   *  but audio already handed to audio.play() runs to completion on its own —
   *  so a new turn/greeting starting over a still-playing reply produces TWO
   *  overlapping voices unless we explicitly pause the old element here. */
  const stopCurrentAudio = () => {
    const audio = playbackAudioRef.current;
    playbackAudioRef.current = null;
    if (audio) {
      // Leave onpause intact so the old playBlob's promise still resolves and
      // its (now token-stale) chain unwinds cleanly.
      try {
        audio.pause();
      } catch {
        // ignore
      }
    }
    stopWaveformLoop();
  };

  /** Interrupt the model mid-speech (barge-in or new turn): stop playback and
   *  invalidate the in-flight speak() loop so it stops queuing more sentences. */
  const cancelSpeech = () => {
    speakTokenRef.current += 1;
    // Stop generating the interrupted reply (saves tokens + prevents a late
    // sentence from sneaking into TTS after the barge-in).
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    stopCurrentAudio();
    setSpeakingSync(false);
  };

  /**
   * Speak a line via the local Pocket-TTS server, then (in hands-free mode)
   * automatically start listening again once playback ends. The server has
   * no streaming endpoint — a full reply must finish generating before any
   * audio comes back, and generation time scales with text length, so a long
   * reply means a long silent wait. To fake streaming: split into sentences
   * and pipeline the fetches — sentence N+1 generates in the background while
   * sentence N is playing, so time-to-first-sound is just one sentence's
   * generation time (~1-2s) instead of the whole reply's (~5-6s+).
   */
  const speak = async (text: string): Promise<void> => {
    const sentences = splitIntoSentences(text);
    if (sentences.length === 0) return;
    // Claim this speech turn. Any barge-in or newer reply bumps the token,
    // and every await below bails the instant it sees the token has moved on.
    const myToken = ++speakTokenRef.current;
    // Silence any audio still playing from a previous turn so we never stack
    // two voices, and abort any stream still feeding the old reply.
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    stopCurrentAudio();
    setTtsError("");
    setSpeakingSync(true);
    try {
      let nextFetch = fetchTtsBlob(sentences[0]);
      for (let i = 0; i < sentences.length; i++) {
        if (speakTokenRef.current !== myToken) break;
        const blob = await nextFetch;
        nextFetch = i + 1 < sentences.length ? fetchTtsBlob(sentences[i + 1]) : Promise.resolve(null);
        if (speakTokenRef.current !== myToken) break;
        if (blob) await playBlob(blob, myToken);
      }
    } finally {
      // Only clear "speaking" if we're still the current turn. If we were
      // interrupted, cancelSpeech() already cleared it and started capturing —
      // don't stomp that. The always-on monitor loop handles resuming
      // listening; no manual startRecording() call needed anymore.
      if (speakTokenRef.current === myToken) {
        setSpeakingSync(false);
      }
    }
  };

  /**
   * The low-latency path for spoken replies: stream the LLM's tokens and start
   * TTS on each COMPLETE sentence as it arrives, so audio begins after the
   * first sentence instead of after the whole (multi-second) completion. TTS
   * fetches are pipelined (kicked off the moment a sentence is ready) but
   * played strictly in order via a serial chain. Returns the full sanitized
   * reply text for chat/history/bible bookkeeping. Falls back to a normal
   * non-streamed askModel+speak on any streaming error.
   */
  const respondAndSpeak = async (instructions: string): Promise<string> => {
    const finalInstructions = `${instructions}\n\nVOICE MODE — CRITICAL: this is spoken aloud, not read. Keep your ENTIRE reply to 2 short sentences maximum. Brevity matters far more here than in text.\n\n${OUTPUT_FORMAT_GUARD}`;
    const myToken = ++speakTokenRef.current;
    // Abort any prior stream and silence any audio still playing from a
    // previous turn — guarantees a single voice, no leftover speech.
    streamAbortRef.current?.abort();
    stopCurrentAudio();
    const abort = new AbortController();
    streamAbortRef.current = abort;
    setTtsError("");

    let full = "";
    let buffer = "";
    let firstAudio = false;
    let playChain: Promise<void> = Promise.resolve();

    const enqueue = (sentence: string) => {
      const clean = sanitizeModelReply(sentence).trim();
      if (!clean || !looksLikeUsableReply(clean)) return;
      if (!firstAudio) {
        firstAudio = true;
        setSendingSync(false);
        setSpeakingSync(true);
      }
      const fetchPromise = fetchTtsBlob(clean); // starts generating immediately
      playChain = playChain.then(async () => {
        if (speakTokenRef.current !== myToken) return;
        const blob = await fetchPromise;
        if (blob && speakTokenRef.current === myToken) await playBlob(blob, myToken);
      });
    };

    try {
      const r = await fetch(withBase("/api/voice-turn"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: finalInstructions, stream: true, history: historyRef.current }),
        signal: abort.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`Voice turn failed (${r.status})`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        if (speakTokenRef.current !== myToken) break; // interrupted
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        full += chunk;
        buffer += chunk;
        const { sentences, rest } = drainSentences(buffer);
        buffer = rest;
        for (const s of sentences) enqueue(s);
      }
      // Flush any trailing partial sentence (reply that didn't end on punctuation).
      if (speakTokenRef.current === myToken && buffer.trim()) enqueue(buffer);
    } catch (e) {
      if (speakTokenRef.current === myToken && (e as Error)?.name !== "AbortError") {
        // Streaming failed outright and we never spoke — fall back to the
        // reliable non-streamed path so the turn isn't silently lost.
        if (!firstAudio) {
          try {
            const text = await askModel(instructions);
            await speak(text);
            return text;
          } catch (e2) {
            setTtsError(String((e2 as Error)?.message ?? "Voice turn failed"));
          }
        }
      }
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
    }
    // Return the full text NOW (streaming is done) so the caller can update
    // chat/history/bible promptly, while audio keeps playing in the
    // background. Clear the speaking flag once the play queue fully drains.
    void playChain.then(() => {
      if (speakTokenRef.current === myToken) {
        setSendingSync(false);
        setSpeakingSync(false);
      }
    });
    if (!firstAudio && speakTokenRef.current === myToken) {
      // Nothing was ever spoken (empty/all-filtered reply) — don't leave the
      // UI stuck on "thinking/speaking".
      setSendingSync(false);
      setSpeakingSync(false);
    }
    return sanitizeModelReply(full).trim() || full.trim();
  };

  const autosave = async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    const bibleToSave = bibleRef.current;
    const imagesToSave = imagesRef.current;
    const coreChoice = getCoreChoice(bibleToSave);
    const hasContent = !!coreChoice || bibleToSave.turnCount > 0 || imagesToSave.length > 0;
    if (!hasContent) return;
    const title = pickSessionTitle(bibleToSave);
    try {
      const existing = await getGame(id);
      await saveGame({
        id,
        createdAt: existing?.createdAt ?? Date.now(),
        title,
        titleIsCustom: existing?.titleIsCustom ?? false,
        finalRecordText: finalRecord ?? "",
        summary: summaryRef.current,
        bible: bibleToSave,
        images: imagesToSave,
      });
      window.dispatchEvent(new Event("society-sessions-updated"));
      setLastSaveAt(new Date().toLocaleString());
      setLastSaveTitle(title);
    } catch (e) {
      addLine("sys", `Save failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  useEffect(() => {
    if (!sessionIdRef.current) return;
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      autosave();
    }, 800);
    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bible, images, summary, sessionId]);

  function applyBibleUpdate(update: BibleUpdate) {
    setBible((prev) => {
      const turn = prev.turnCount + 1;
      let next = bumpTurn(prev);
      if (update.addCanon?.length) next = addCanonLines(next, update.addCanon, turn);
      if (update.addOpenThreads?.length) next = addOpenThreads(next, update.addOpenThreads);
      return next;
    });
  }

  async function requestOobBibleUpdate(lastAiText: string) {
    if (!bibleRef.current.canon.coreValues[0]) return;
    if (!lastAiText?.trim()) return;
    const requestSessionId = sessionIdRef.current;
    try {
      const r = await fetch(withBase("/api/bible-update"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bible: bibleRef.current, lastAiTranscript: lastAiText }),
      });
      if (!r.ok) return;
      const data = await r.json().catch(() => null);
      if (!data) return;
      if (sessionIdRef.current !== requestSessionId) return;
      applyBibleUpdate({
        addCanon: Array.isArray(data.addCanon) ? data.addCanon.map(String) : [],
        addOpenThreads: Array.isArray(data.addOpenThreads) ? data.addOpenThreads.map(String) : [],
        contradictionsFound: Array.isArray(data.contradictionsFound) ? data.contradictionsFound.map(String) : [],
        reconciliationOptions: Array.isArray(data.reconciliationOptions) ? data.reconciliationOptions.map(String) : [],
      });
    } catch {
      // best-effort
    }
  }

  const onGenerateImage = async () => {
    if (imageBusy) return;
    if (!sessionIdRef.current) {
      addLine("sys", "Image skipped: no session id yet.");
      return;
    }
    setImageBusy(true);
    const requestSessionId = sessionIdRef.current;
    const requestTurn = bibleRef.current.turnCount;
    addLine("sys", "Generating image scene…");
    try {
      const r = await fetch(withBase("/api/image-scene"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bible: bibleRef.current, styleGuide: imageStyleGuide, sessionId: requestSessionId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || (!data?.b64 && !data?.imagePath)) {
        const detail = `${String(data?.error ?? r.status)}${data?.code ? ` (${String(data.code)})` : ""}`;
        addLine("sys", `Image scene error: ${detail}`);
        window.dispatchEvent(
          new CustomEvent("society-image-alert", {
            detail: {
              level: data?.code === "moderation_blocked" ? "safety" : "error",
              message:
                data?.code === "moderation_blocked"
                  ? "Image request was blocked by safety filters. Try a less explicit phrasing."
                  : "Could not generate image for this turn.",
            },
          })
        );
        lastAutoImageFailureTurnRef.current = requestTurn;
        return;
      }
      if (sessionIdRef.current !== requestSessionId) {
        addLine("sys", "Discarded image for previous session.");
        return;
      }
      lastAutoImageFailureTurnRef.current = -1;
      if (!imageStyleGuide && data.styleGuide) setImageStyleGuide(data.styleGuide);
      setImages((prev) => [
        ...prev,
        {
          b64: data.b64 ? String(data.b64) : undefined,
          imagePath: data.imagePath ? String(data.imagePath) : undefined,
          title: String(data.title ?? "Society scene"),
          caption: String(data.caption ?? ""),
          seedFacts: Array.isArray(data.seedFacts) ? data.seedFacts.map(String) : [],
          promptUsed: String(data.promptUsed ?? "").slice(0, 4000),
          at: new Date().toLocaleString(),
        } satisfies GeneratedImage,
      ]);
      window.dispatchEvent(
        new CustomEvent("society-activity", { detail: { message: `Image: ${data.title ?? "scene"}` } })
      );
    } finally {
      setImageBusy(false);
    }
  };

  useEffect(() => {
    if (!autoImages) return;
    if (!active) return;
    if (!playedThisSessionRef.current) return; // not on resume/recap — only real play
    if (recapPlaying) return;
    if (imageBusy) return;
    if (!bible.canon.coreValues[0]) return;
    if (images.length > 0) return;
    if (lastAutoImageFailureTurnRef.current === bible.turnCount) return;
    if (bible.turnCount < 1) return;
    if (!hasConcreteFirstImageAnchor(bible)) return;
    onGenerateImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bible.canon.coreValues[0], bible.lastAiUtterance, bible.turnCount, bible.changelog.length, active, imageBusy, autoImages, images.length, recapPlaying]);

  useEffect(() => {
    if (!autoImages) return;
    if (!active) return;
    if (!playedThisSessionRef.current) return; // not on resume/recap — only real play
    if (recapPlaying) return;
    if (imageBusy) return;
    if (images.length === 0) return;
    if (bible.turnCount <= 0) return;
    if (autoEveryTurns <= 0) return;
    if (bible.turnCount % autoEveryTurns !== 0) return;
    if (lastAutoImageTurnRef.current === bible.turnCount) return;
    if (lastAutoImageFailureTurnRef.current === bible.turnCount) return;
    lastAutoImageTurnRef.current = bible.turnCount;
    onGenerateImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoImages, autoEveryTurns, bible.turnCount, active, imageBusy, images.length, recapPlaying]);

  // Safety net: never leave the recap UI (Skip button + slideshow highlight)
  // stuck on if the session goes inactive for any reason.
  useEffect(() => {
    if (!active && recapPlaying) {
      setRecapPlaying(false);
      window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { done: true } }));
    }
  }, [active, recapPlaying]);

  const finishAndSave = async () => {
    setSendingSync(true);
    addLine("sys", "Wrapping up — generating summary…");
    try {
      const recapText = await askModel(`Respond only in English. ${recapPrompt(bibleRef.current)}`, true);
      const parsed = safeJsonParse<any>(recapText);
      const canonRecap: string[] = Array.isArray(parsed?.canonRecap) ? parsed.canonRecap.map(String).slice(0, 16) : [];
      const openThreads: string[] = Array.isArray(parsed?.openThreads) ? parsed.openThreads.map(String).slice(0, 12) : [];
      const nextMoves: string[] = Array.isArray(parsed?.nextMoves) ? parsed.nextMoves.map(String).slice(0, 8) : [];
      const md = [
        `## Summary so far`,
        `**Updated**: ${new Date().toLocaleString()}`,
        canonRecap.length ? `\n### Canon\n${canonRecap.map((x) => `- ${x.replaceAll("\n", " ").trim()}`).join("\n")}` : "",
        openThreads.length ? `\n### Open threads\n${openThreads.map((x) => `- ${x.replaceAll("\n", " ").trim()}`).join("\n")}` : "",
        nextMoves.length ? `\n### Suggested next moves\n${nextMoves.map((x) => `- ${x.replaceAll("\n", " ").trim()}`).join("\n")}` : "",
        "",
      ]
        .filter(Boolean)
        .join("\n");
      const finalSummary = canonRecap.length || openThreads.length || nextMoves.length ? md : recapText;
      setSummary(finalSummary);
      summaryRef.current = finalSummary;
      addLine("sys", "Generated summary so far.");

      const finalText = await askModel(finalBreakdownPrompt(bibleRef.current), true);
      const finalParsed = safeJsonParse<any>(finalText);
      const pretty = finalParsed ? JSON.stringify(finalParsed, null, 2) : finalText;
      setFinalRecord(pretty);

      const coreChoice = getCoreChoice(bibleRef.current);
      if (!coreChoice) {
        addLine("sys", "Skipped save: core value not set yet.");
        setActiveSync(false);
        return;
      }
      const id =
        sessionIdRef.current ||
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto.randomUUID() as string)
          : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      const title = pickSessionTitle(
        bibleRef.current,
        String(finalParsed?.core_values?.[0] ?? "").trim(),
        String(finalParsed?.title ?? "").trim()
      );
      const existing = await getGame(id);
      await saveGame({
        id,
        createdAt: existing?.createdAt ?? Date.now(),
        title,
        titleIsCustom: existing?.titleIsCustom ?? false,
        finalRecordText: pretty,
        summary: finalSummary,
        bible: bibleRef.current,
        images: imagesRef.current,
      });
      window.dispatchEvent(new Event("society-sessions-updated"));
      setHistory(await listGames());
      setLastSaveAt(new Date().toLocaleString());
      setLastSaveTitle(title);
      window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: `Saved: ${title}` } }));
      addLine("sys", "Saved session record.");
    } catch (e) {
      addLine("sys", `Wrap-up failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setSendingSync(false);
      setActiveSync(false);
    }
  };

  async function start() {
    // Shield the sessionId change we're about to make from the session-change
    // teardown effect (see its guard). Cleared after the effect has had a
    // chance to flush on the next tick.
    startingRef.current = true;
    setTimeout(() => {
      startingRef.current = false;
    }, 0);
    // This Start click is the one guaranteed direct user gesture — use it to
    // unlock the AudioContext AND open the persistent mic. openMic keeps the
    // mic live for the whole session and kicks off the always-on VAD loop, so
    // every later turn (and barge-in) works without any further gesture.
    void ensureAudioContext();
    void openMic();
    // Reset per-session gates: a resumed/recapped session hasn't been "played"
    // until the player speaks, so auto-images stay off until then.
    playedThisSessionRef.current = false;
    lastAutoImageTurnRef.current = bibleRef.current.turnCount;
    const mode = startModeRef.current;
    if (mode === "new") {
      const b = bibleRef.current;
      const hasProgress =
        !!sessionIdRef.current &&
        (Boolean(b.canon.coreValues?.[0]) || b.turnCount > 0 || (b.changelog?.length ?? 0) > 0 || imagesRef.current.length > 0);
      if (hasProgress) startModeRef.current = "continue";
    }
    const effectiveMode = startModeRef.current;

    if (effectiveMode === "new") {
      sessionIdRef.current = "";
      bibleRef.current = createEmptyBible();
      imagesRef.current = [];
      setBible(createEmptyBible());
      setImages([]);
      setChat([]);
      setSummary("");
      setFinalRecord("");
      historyRef.current = [];
    }
    if (!sessionIdRef.current) {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto.randomUUID() as string)
          : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      // Claim the new id as "already current" BEFORE setSessionId triggers the
      // session-change effect — otherwise that effect sees a foreign id and
      // tears the session down (closeMic + setActive(false)) the instant we
      // start a new game, killing the greeting and the mic we just opened.
      lastSessionIdRef.current = id;
      setSessionId(id);
      sessionIdRef.current = id;
    }

    setActiveSync(true);
    window.dispatchEvent(new Event("society-started"));

    if (effectiveMode === "recap") {
      onboardingPhaseRef.current = "done";
      const recapImages = imagesRef.current;
      recapSkipRef.current = false;
      setRecapPlaying(true);
      setSendingSync(true);
      // Reset to the FIRST image immediately — otherwise the last image (the
      // normal "show newest" state) lingers on screen during the 2-4s it takes
      // to generate the beats, so the recap appears to start on the final scene.
      if (recapImages.length > 0) {
        window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { index: 0 } }));
      }
      try {
        if (recapImages.length > 0) {
          // Slideshow-synced recap: one story beat per image, spoken while that
          // image is on screen, so the tale is illustrated live as you listen.
          const captions = recapImages.map((i) => i.caption || i.title || "");
          const raw = await askModel(recapSlideshowPrompt(bibleRef.current, captions), true, { maxTokens: 1100 });
          const parsed = safeJsonParse<any>(raw);
          const beats: string[] = Array.isArray(parsed?.beats) ? parsed.beats.map(String) : [];
          const intro = String(parsed?.intro ?? "").trim();
          const outro = String(parsed?.outro ?? "").trim();
          setSendingSync(false);

          if (beats.length === 0) {
            // Model didn't return per-image beats — fall back to a plain story recap.
            const text = await askModel(`Respond only in English. ${recapNarrationPrompt(bibleRef.current, captions)}`, false, {
              brief: false,
              maxTokens: 800,
            });
            addLine("assistant", text);
            pushHistory("assistant", text);
            window.dispatchEvent(new CustomEvent("society-recap-slideshow", { detail: { intervalMs: 6000 } }));
            await speak(text);
          } else {
            const spoken: string[] = [];
            // Show the first image with the intro, then walk each image in
            // lockstep with its beat. Bail if the player skips, barges in, or stops.
            const stillRecapping = () =>
              activeRef.current && !recordingRef.current && !sendingRef.current && !recapSkipRef.current;
            window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { index: 0 } }));
            if (intro) {
              spoken.push(intro);
              await speak(intro);
            }
            for (let i = 0; i < recapImages.length; i++) {
              if (!stillRecapping()) break;
              window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { index: i } }));
              const beat = (beats[i] ?? "").trim();
              if (beat) {
                spoken.push(beat);
                await speak(beat);
              }
            }
            // Land on the LAST image for the outro/question, and leave it there.
            if (stillRecapping()) {
              window.dispatchEvent(
                new CustomEvent("society-recap-show-image", { detail: { index: recapImages.length - 1 } })
              );
            }
            if (outro && stillRecapping()) {
              spoken.push(outro);
              await speak(outro);
            }
            window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { done: true } }));
            const full = spoken.join(" ").trim();
            if (full) {
              addLine("assistant", full);
              pushHistory("assistant", full);
            }
          }
        } else {
          // No images — a plain spoken story chronicle.
          const text = await askModel(`Respond only in English. ${recapNarrationPrompt(bibleRef.current, [])}`, false, {
            brief: false,
            maxTokens: 800,
          });
          addLine("assistant", text);
          pushHistory("assistant", text);
          setSendingSync(false);
          await speak(text);
        }
      } catch (e) {
        addLine("sys", `Recap failed: ${String((e as Error)?.message ?? e)}`);
        setSendingSync(false);
      } finally {
        setRecapPlaying(false);
        window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { done: true } }));
      }
      startModeRef.current = "continue";
    } else if (effectiveMode === "continue") {
      onboardingPhaseRef.current = "done";
      const resumeBible = bibleRef.current;
      const coreValue = getCoreChoice(resumeBible);
      if (!String(resumeBible.canon.coreValues?.[0] ?? "").trim() && coreValue) {
        bibleRef.current = structuredClone(resumeBible);
        bibleRef.current.canon.coreValues[0] = coreValue;
        setBible(bibleRef.current);
        void autosave();
      }
      const recentCanon =
        resumeBible.changelog
          .slice()
          .sort((a, b) => a.turn - b.turn)
          .slice(-8)
          .map((c) => `- ${c.entry}`)
          .join("\n") || "- (none yet)";
      setSendingSync(true);
      try {
        const text = await askModel(buildResumeInstructions(coreValue, recentCanon), false, {
          brief: false,
          maxTokens: 400,
        });
        addLine("assistant", text);
        pushHistory("assistant", text);
        setBible((b) => ({ ...b, lastAiUtterance: text }));
        setSendingSync(false);
        void speak(text);
      } catch (e) {
        addLine("sys", `Resume failed: ${String((e as Error)?.message ?? e)}`);
        setSendingSync(false);
      }
      // Keep the session resumable — a later Stop→Start should resume again,
      // not silently start a brand-new game.
      startModeRef.current = "continue";
    } else {
      onboardingPhaseRef.current = "pre_core";
      addLine("assistant", GREETING_TEXT);
      pushHistory("assistant", GREETING_TEXT);
      void speak(GREETING_TEXT);
    }
  }

  // Stop is a resumable PAUSE, not "end the game": stop the mic + any speech,
  // save progress quickly (autosave, not the slow final-record generation),
  // and set the mode so pressing Start/Play again resumes THIS society. Allowed
  // even mid-speech/mid-think (cancelSpeech aborts the in-flight reply).
  const onStop = () => {
    if (!active) return;
    cancelSpeech();
    closeMic();
    setSendingSync(false);
    setActiveSync(false);
    startModeRef.current = "continue";
    void autosave();
  };

  // Skip an in-progress recap and drop straight into play: stop the narration,
  // end the slideshow, then INVITE the player to add the next element (rather
  // than dropping into silence, which felt like nothing happened).
  const onSkipRecap = () => {
    recapSkipRef.current = true;
    cancelSpeech();
    setRecapPlaying(false);
    window.dispatchEvent(new CustomEvent("society-recap-show-image", { detail: { done: true } }));
    onboardingPhaseRef.current = "done";
    const invite = "Alright, skipping the recap. What part of this society would you like to build out next?";
    addLine("assistant", invite);
    pushHistory("assistant", invite);
    void speak(invite);
  };

  const onDeleteSession = async () => {
    if (!sessionIdRef.current) return;
    const id = sessionIdRef.current;
    try {
      await deleteGame(id);
      setHistory(await listGames());
      window.dispatchEvent(new Event("society-sessions-updated"));
    } catch {
      // ignore
    }
    sessionIdRef.current = "";
    setSessionId("");
    setSummary("");
    setFinalRecord("");
    setImages([]);
    setBible(createEmptyBible());
    setChat([]);
    historyRef.current = [];
    cancelSpeech();
    closeMic();
    setActiveSync(false);
  };

  const onRenameSession = async () => {
    const id = sessionIdRef.current || sessionId;
    const nextTitle = editTitle.trim();
    if (!id || !nextTitle) return;
    sessionIdRef.current = id;
    try {
      const existing = await getGame(id);
      if (existing) {
        await saveGame({ ...existing, title: nextTitle, titleIsCustom: true });
      } else {
        await saveGame({
          id,
          createdAt: Date.now(),
          title: nextTitle,
          titleIsCustom: true,
          finalRecordText: finalRecord ?? "",
          summary: summaryRef.current,
          bible: bibleRef.current,
          images: imagesRef.current,
        });
      }
      setHistory(await listGames());
      window.dispatchEvent(new Event("society-sessions-updated"));
      setLastSaveAt(new Date().toLocaleString());
      setLastSaveTitle(nextTitle);
      setEditTitle(nextTitle);
    } catch {
      // ignore
    }
  };

  const onRecapUpdate = async () => {
    setSendingSync(true);
    try {
      const text = await askModel(`Respond only in English. ${recapPrompt(bibleRef.current)}`, true);
      const parsed = safeJsonParse<any>(text);
      const canonRecap: string[] = Array.isArray(parsed?.canonRecap) ? parsed.canonRecap.map(String).slice(0, 16) : [];
      const openThreads: string[] = Array.isArray(parsed?.openThreads) ? parsed.openThreads.map(String).slice(0, 12) : [];
      const nextMoves: string[] = Array.isArray(parsed?.nextMoves) ? parsed.nextMoves.map(String).slice(0, 8) : [];
      const md = [
        `## Summary so far`,
        `**Updated**: ${new Date().toLocaleString()}`,
        canonRecap.length ? `\n### Canon\n${canonRecap.map((x) => `- ${x.trim()}`).join("\n")}` : "",
        openThreads.length ? `\n### Open threads\n${openThreads.map((x) => `- ${x.trim()}`).join("\n")}` : "",
        nextMoves.length ? `\n### Suggested next moves\n${nextMoves.map((x) => `- ${x.trim()}`).join("\n")}` : "",
        "",
      ]
        .filter(Boolean)
        .join("\n");
      setSummary(canonRecap.length || openThreads.length || nextMoves.length ? md : text);
      addLine("sys", "Summary updated.");
    } catch (e) {
      addLine("sys", `Summary failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setSendingSync(false);
    }
  };

  // Full-duplex VAD tuning. Thresholds are relative to the room's measured
  // noise floor (calibrated once when the mic opens) so a quiet laptop mic or
  // a noisy room both work without a hand-tuned magic number.
  const VAD_CALIBRATION_MS = 400;
  const VAD_MIN_SPEECH_RMS = 0.012; // absolute floor for "this is speech"
  const VAD_NOISE_MULTIPLIER = 2.3; // speech threshold = max(floor, noise * this)
  const VAD_ONSET_MS = 120; // sustained speech before we START capturing (kills click/blip false starts)
  // End-of-turn silence hold is ADAPTIVE: while an utterance is young the
  // player is often mid-thought ("the most important thing is… um…"), so give
  // them a generous window; once they've been talking a while, tighten it so
  // the response feels snappy. A fixed 700ms cut people off early; a fixed
  // 900ms felt laggy — splitting by utterance age serves both.
  const VAD_SILENCE_HOLD_EARLY_MS = 900; // utterance younger than the threshold below
  const VAD_SILENCE_HOLD_MS = 650; // established utterance
  const VAD_EARLY_UTTERANCE_MS = 3000; // "young" cutoff for the above
  // Snappiness: fire transcription this early into trailing silence, in
  // PARALLEL with the (longer) end-of-turn hold, so the ~500ms STT round-trip
  // overlaps the wait instead of adding to it (unmute.sh transcribes while you
  // talk; this is the file-API approximation). The hold still governs when the
  // turn actually ends, so this never cuts anyone off — worst case is a wasted
  // STT call when a pause turns out to be mid-thought.
  const VAD_STT_SPECULATE_MS = 320;
  const VAD_MAX_RECORD_MS = 20000;
  // Barge-in (talking over the model) needs a HIGHER bar than normal onset:
  // the model's own voice leaks into the mic even with echo cancellation, so
  // we require louder + longer sustained speech to interrupt — otherwise the
  // model would constantly cut itself off.
  // Barge-in tuned for real-conversation interruption (unmute.sh feel): with
  // echoCancellation stripping the model's own voice from the mic, the player
  // shouldn't have to SHOUT to interrupt — normal speaking volume held briefly
  // is enough. (Old values 0.05/4×/250ms required a raised voice for ¼s.)
  const VAD_BARGE_MIN_RMS = 0.022;
  const VAD_BARGE_MULTIPLIER = 3;
  const VAD_BARGE_MS = 160;

  /** Open the mic once and keep it live for the whole session, then start the
   *  single continuous VAD loop. Called on Start (a real user gesture, so the
   *  permission prompt + AudioContext unlock both happen here). */
  const openMic = async (): Promise<void> => {
    if (micStreamRef.current) return; // already open
    setMicError("");
    try {
      // Explicit constraints rather than browser defaults — autoGainControl
      // boosts a quiet/far voice before it hits our VAD; echoCancellation is
      // what makes barge-in viable (keeps the model's own voice from
      // constantly tripping the mic).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const ctx = await ensureAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      micSourceRef.current = source;
      analyserRef.current = analyser;
      // Continuous PCM tap with rolling pre-roll (see pcmChunksRef). The
      // processor must be connected toward the destination to fire in all
      // browsers — via a zero-gain node so the mic is never audible.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(processor);
      processor.connect(silent);
      silent.connect(ctx.destination);
      pcmSampleRateRef.current = ctx.sampleRate;
      const prerollChunks = Math.max(2, Math.ceil((ctx.sampleRate * 0.4) / 4096));
      pcmChunksRef.current = [];
      processor.onaudioprocess = (e) => {
        pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        if (!recordingRef.current) {
          const extra = pcmChunksRef.current.length - prerollChunks;
          if (extra > 0) pcmChunksRef.current.splice(0, extra);
        }
      };
      pcmProcessorRef.current = processor;
      pcmSilentGainRef.current = silent;
      // After system sleep or an input-device switch the OS kills the capture
      // track — without this handler the VAD loop keeps reading zeros forever
      // while showing "Waiting for you to speak". Reopen the mic immediately.
      stream.getAudioTracks().forEach((t) => {
        t.onended = () => {
          void reacquireMic();
        };
      });
      // Reset detection state and recalibrate the noise floor for this session.
      noiseFloorRef.current = VAD_MIN_SPEECH_RMS;
      calibrationSamplesRef.current = [];
      calibrationStartRef.current = Date.now();
      calibrationDoneRef.current = false;
      hasSpokenRef.current = false;
      silenceSinceRef.current = null;
      speechOnsetSinceRef.current = null;
      bargeSinceRef.current = null;
      startMonitorLoop();
    } catch {
      setMicError("Mic access denied or unavailable.");
    }
  };

  const closeMic = () => {
    if (monitorRafRef.current !== null) {
      cancelAnimationFrame(monitorRafRef.current);
      monitorRafRef.current = null;
    }
    pcmProcessorRef.current?.disconnect();
    pcmProcessorRef.current = null;
    pcmSilentGainRef.current?.disconnect();
    pcmSilentGainRef.current = null;
    pcmChunksRef.current = [];
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    analyserRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => {
      t.onended = null; // deliberate close — don't let the handler "recover" it
      t.stop();
    });
    micStreamRef.current = null;
    setRecordingSync(false);
    stopWaveformLoop();
  };

  /** Tear down and reopen a dead mic capture. The OS can kill or permanently
   *  mute the track (sleep/wake, AirPods connecting, input-device switch)
   *  without any error surfacing — the session then looks alive but hears
   *  nothing. Called from track.onended and the monitor loop's health check. */
  const reacquireMic = async (): Promise<void> => {
    if (micReacquiringRef.current) return;
    if (!activeRef.current) return; // session was stopped; nothing to heal
    micReacquiringRef.current = true;
    try {
      closeMic();
      await openMic();
      if (micStreamRef.current) {
        addLine("sys", "Mic connection was lost (sleep or device switch) — reconnected.");
      }
    } finally {
      micReacquiringRef.current = false;
    }
  };

  /** The single always-on loop. Reads the mic every frame and drives the whole
   *  turn-taking state machine: idle → capture on speech, end capture on
   *  trailing silence, and barge-in (interrupt the model) while it speaks. */
  const startMonitorLoop = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const timeBuffer = new Uint8Array(analyser.fftSize);
    const freqBuffer = new Uint8Array(analyser.frequencyBinCount);
    // Diagnostic: throttled VAD tracing so a live session can be watched from
    // the browser console (filter on "[VAD]"). Toggle with window.__VAD_DEBUG;
    // defaults on in dev. Logs the speech envelope during capture + the exact
    // reason/timings when a turn is ended, to see if the cutoff is a real pause
    // or the threshold clipping quiet speech.
    let lastVadLog = 0;
    const vadDebug = () =>
      typeof window !== "undefined" &&
      ((window as any).__VAD_DEBUG ?? process.env.NODE_ENV !== "production");
    // Mic health check state (see the dead-track guard at the top of tick).
    let lastTrackCheck = 0;
    let trackMutedSince: number | null = null;

    const tick = () => {
      const a = analyserRef.current;
      if (!a) return;
      a.getByteTimeDomainData(timeBuffer);
      let sumSquares = 0;
      for (let i = 0; i < timeBuffer.length; i++) {
        const n = (timeBuffer[i] - 128) / 128;
        sumSquares += n * n;
      }
      const rms = Math.sqrt(sumSquares / timeBuffer.length);
      const now = Date.now();

      // Dead-mic self-healing (~1s cadence): after sleep/wake or an input-
      // device switch the capture track can end — or stick muted — without any
      // event we handle reliably, leaving this loop reading zeros forever
      // while the UI says "Waiting for you to speak". Detect it and reopen.
      if (now - lastTrackCheck >= 1000) {
        lastTrackCheck = now;
        const track = micStreamRef.current?.getAudioTracks()[0];
        if (track) {
          if (track.readyState === "ended") {
            if (vadDebug()) {
              // eslint-disable-next-line no-console
              console.log("[VAD] 🔌 mic track ended — reacquiring");
            }
            void reacquireMic();
            return; // don't schedule another frame; reacquireMic starts a fresh loop
          }
          if (track.muted) {
            if (trackMutedSince === null) {
              trackMutedSince = now;
            } else if (now - trackMutedSince >= 2000) {
              trackMutedSince = null;
              if (vadDebug()) {
                // eslint-disable-next-line no-console
                console.log("[VAD] 🔇 mic track stuck muted — reacquiring");
              }
              void reacquireMic();
              return;
            }
          } else {
            trackMutedSince = null;
          }
        }
      }

      // One-time noise-floor calibration right after the mic opens. Never
      // calibrate over the model's own voice (e.g. the greeting playing before
      // the window finishes) — that would inflate the floor and make the user
      // harder to hear. If the model is speaking, restart the quiet window.
      if (!calibrationDoneRef.current) {
        if (speakingRef.current) {
          calibrationStartRef.current = now;
          calibrationSamplesRef.current = [];
          monitorRafRef.current = requestAnimationFrame(tick);
          return;
        }
        calibrationSamplesRef.current.push(rms);
        if (now - (calibrationStartRef.current ?? now) >= VAD_CALIBRATION_MS) {
          const s = calibrationSamplesRef.current;
          const avg = s.length ? s.reduce((x, y) => x + y, 0) / s.length : VAD_MIN_SPEECH_RMS;
          noiseFloorRef.current = avg;
          calibrationDoneRef.current = true;
          if (vadDebug()) {
            // eslint-disable-next-line no-console
            console.log(
              `[VAD] ✅ calibrated floor=${avg.toFixed(4)} → speechThr=${Math.max(
                VAD_MIN_SPEECH_RMS,
                avg * VAD_NOISE_MULTIPLIER
              ).toFixed(4)} (samples=${s.length}). If your speaking rms below stays under speechThr, the mic is too quiet / floor too high.`
            );
          }
        }
      } else {
        const speechThreshold = Math.max(VAD_MIN_SPEECH_RMS, noiseFloorRef.current * VAD_NOISE_MULTIPLIER);
        const bargeThreshold = Math.max(VAD_BARGE_MIN_RMS, noiseFloorRef.current * VAD_BARGE_MULTIPLIER);
        const isSpeech = rms > speechThreshold;

        if (recordingRef.current) {
          // Actively capturing the user's utterance — watch for end-of-turn.
          if (isSpeech) {
            hasSpokenRef.current = true;
            silenceSinceRef.current = null;
            invalidateSpeculativeStt(); // a resumed word makes the pending transcript stale
          } else if (hasSpokenRef.current && silenceSinceRef.current === null) {
            silenceSinceRef.current = now;
          }
          const silenceElapsed = silenceSinceRef.current ? now - silenceSinceRef.current : 0;
          const totalElapsed = now - (captureStartedAtRef.current ?? now);
          // Adaptive hold: generous while the utterance is young (mid-thought
          // pauses), tighter once established (snappy turn-taking).
          const holdMs = totalElapsed < VAD_EARLY_UTTERANCE_MS ? VAD_SILENCE_HOLD_EARLY_MS : VAD_SILENCE_HOLD_MS;
          // Head-start the transcription partway through the silence so its
          // round-trip overlaps the remaining hold instead of following it.
          if (hasSpokenRef.current && silenceElapsed >= VAD_STT_SPECULATE_MS) {
            fireSpeculativeStt();
          }
          // Live envelope trace (throttled ~150ms) — shows RMS vs the threshold
          // it must clear to count as speech, so a quiet stretch that is about
          // to trip the silence timer is visible before the cutoff fires.
          if (vadDebug() && now - lastVadLog >= 150) {
            lastVadLog = now;
            // eslint-disable-next-line no-console
            console.log(
              `[VAD] rec rms=${rms.toFixed(4)} thr=${speechThreshold.toFixed(4)} floor=${noiseFloorRef.current.toFixed(4)} ${
                isSpeech ? "SPEECH" : "quiet"
              } silence=${silenceElapsed}ms/${holdMs} total=${(totalElapsed / 1000).toFixed(1)}s`
            );
          }
          const hitSilence = hasSpokenRef.current && silenceElapsed >= holdMs;
          const hitMax = totalElapsed >= VAD_MAX_RECORD_MS;
          if (hitSilence || hitMax) {
            if (vadDebug()) {
              // eslint-disable-next-line no-console
              console.log(
                `[VAD] ⛔ END capture — reason=${hitMax ? "MAX_RECORD (20s cap)" : "silence hold"} silence=${silenceElapsed}ms total=${(
                  totalElapsed / 1000
                ).toFixed(1)}s lastRms=${rms.toFixed(4)} thr=${speechThreshold.toFixed(4)}`
              );
            }
            endCapture();
          }
        } else if (speakingRef.current) {
          // Model is talking — listen for the user barging in over it.
          if (rms > bargeThreshold) {
            if (bargeSinceRef.current === null) bargeSinceRef.current = now;
            if (now - bargeSinceRef.current >= VAD_BARGE_MS) {
              bargeSinceRef.current = null;
              cancelSpeech();
              beginCapture(now);
            }
          } else {
            bargeSinceRef.current = null;
          }
        } else if (!sendingRef.current) {
          // Idle, waiting for the user. Require a short sustained onset so a
          // single click/thump doesn't start a phantom capture.
          // Throttled idle trace — THIS is the "Waiting for you to speak" state.
          // If rms stays under speechThr while you talk, onset never fires and
          // capture never starts (the exact "it says waiting but I'm speaking"
          // bug). Peak rms vs speechThr tells us if the threshold is too high.
          if (vadDebug() && now - lastVadLog >= 150) {
            lastVadLog = now;
            // eslint-disable-next-line no-console
            console.log(
              `[VAD] idle rms=${rms.toFixed(4)} speechThr=${speechThreshold.toFixed(4)} floor=${noiseFloorRef.current.toFixed(4)} ${
                isSpeech ? "SPEECH (onset building)" : "below-threshold (waiting)"
              }`
            );
          }
          if (isSpeech) {
            if (speechOnsetSinceRef.current === null) speechOnsetSinceRef.current = now;
            if (now - speechOnsetSinceRef.current >= VAD_ONSET_MS) {
              speechOnsetSinceRef.current = null;
              beginCapture(now);
            }
          } else {
            speechOnsetSinceRef.current = null;
          }
        }
      }

      // Draw the mic-reactive waveform whenever the model isn't speaking
      // (during speech, playBlob's own loop drives the canvas from the TTS).
      if (!speakingRef.current) {
        paintBars(a, freqBuffer);
      }
      monitorRafRef.current = requestAnimationFrame(tick);
    };
    monitorRafRef.current = requestAnimationFrame(tick);
  };

  /** Start recording a user utterance. The continuous PCM tap (see openMic)
   *  already holds the last ~400ms — the syllable spoken BEFORE the VAD
   *  confirmed this is speech — so "starting" is just flipping the recording
   *  flag, which stops the rolling buffer from being trimmed. */
  const beginCapture = (now: number) => {
    if (recordingRef.current) return;
    if (!micStreamRef.current || !pcmProcessorRef.current) return;
    captureStartedAtRef.current = now;
    hasSpokenRef.current = true; // we only get here because speech was detected
    silenceSinceRef.current = null;
    specSttFiredRef.current = false;
    specSttPromiseRef.current = null;
    setRecordingSync(true);
    if (typeof window !== "undefined" && ((window as any).__VAD_DEBUG ?? process.env.NODE_ENV !== "production")) {
      // eslint-disable-next-line no-console
      console.log(
        `[VAD] ▶️ BEGIN capture — floor=${noiseFloorRef.current.toFixed(4)} speechThr=${Math.max(
          VAD_MIN_SPEECH_RMS,
          noiseFloorRef.current * VAD_NOISE_MULTIPLIER
        ).toFixed(4)} holdMs=${VAD_SILENCE_HOLD_EARLY_MS}(early)/${VAD_SILENCE_HOLD_MS}`
      );
    }
  };

  /** Fire the transcription request for a WAV blob. Pure network call — returns
   *  the trimmed transcript ("" if empty/no audio). Used both speculatively
   *  (during the hold) and, as a fallback, at endCapture. */
  const transcribeBlob = async (blob: Blob): Promise<string> => {
    if (blob.size <= 44) return ""; // WAV header only — no audio
    const form = new FormData();
    form.set("audio", blob, "speech.wav");
    // Bias transcription toward THIS society's vocabulary so unusual answers
    // (proper nouns, "beach culture", faction names) aren't misheard. The core
    // value + the agent's last question are the words the player is most likely
    // echoing right now. Kept short — a long prompt hurts accuracy.
    const b = bibleRef.current;
    const hintParts = [b?.canon?.coreValues?.[0], b?.lastAiUtterance].filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0
    );
    const hint = hintParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
    if (hint) form.set("hint", hint);
    const r = await fetch(withBase("/api/transcribe"), { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || typeof data?.text !== "string") {
      throw new Error(String(data?.error ?? "Transcription failed"));
    }
    return data.text.trim();
  };

  /** Snapshot the current buffer and start transcribing it NOW, in parallel
   *  with the still-running end-of-turn hold (see VAD_STT_SPECULATE_MS). */
  const fireSpeculativeStt = () => {
    if (specSttFiredRef.current) return;
    const sampleRate = pcmSampleRateRef.current;
    if (!pcmChunksRef.current.length || !sampleRate) return;
    specSttFiredRef.current = true;
    setTranscribing(true);
    // slice() → a stable snapshot; the tap keeps appending (only trailing
    // silence) until endCapture, so this transcript is already complete.
    specSttPromiseRef.current = transcribeBlob(encodeWavFromPcm(pcmChunksRef.current.slice(), sampleRate));
  };

  /** A resumed word invalidates any pending speculative transcript. */
  const invalidateSpeculativeStt = () => {
    specSttFiredRef.current = false;
    specSttPromiseRef.current = null; // in-flight fetch still completes but is ignored
  };

  // The mic never closes mid-session, so dead-end paths (empty/junk/failed
  // transcription) just return — the always-on monitor loop is already
  // listening for the next utterance. No manual restart needed.
  const finishTranscript = (text: string) => {
    setTranscribing(false);
    const t = text.trim();
    if (!t) return;
    // Whisper hallucinates plausible-sounding boilerplate (URLs, "thank you for
    // watching") on silence/background noise rather than recognizing there's no
    // real speech — discard it rather than treating fabricated text as speech.
    if (isSpuriousUserTranscript(t)) {
      addLine("sys", "Ignored a junk transcription (likely background noise) — go ahead and speak again.");
      return;
    }
    void sendUserMessage(t);
  };

  const endCapture = () => {
    if (!recordingRef.current) return;
    setRecordingSync(false);
    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const sampleRate = pcmSampleRateRef.current;
    // Prefer the speculative transcript already in flight (its ~500ms overlapped
    // the hold); fall back to a fresh transcription if none was fired.
    const spec = specSttPromiseRef.current;
    specSttPromiseRef.current = null;
    specSttFiredRef.current = false;
    const p = spec ?? (chunks.length && sampleRate ? transcribeBlob(encodeWavFromPcm(chunks, sampleRate)) : null);
    if (!p) return;
    p.then(finishTranscript).catch((e) => {
      setTranscribing(false);
      setMicError(String((e as Error)?.message ?? "Transcription failed"));
    });
  };

  useEffect(() => {
    return () => {
      if (monitorRafRef.current !== null) cancelAnimationFrame(monitorRafRef.current);
      if (waveRafRef.current !== null) cancelAnimationFrame(waveRafRef.current);
      sharedAudioContextRef.current?.close().catch(() => {});
      pcmProcessorRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      playbackAudioRef.current?.pause();
    };
  }, []);

  const sendUserMessage = async (raw: string) => {
    const transcript = raw.trim();
    if (!transcript || sendingRef.current || !activeRef.current) return;
    // The player is actually playing now — auto-images may generate from here on.
    playedThisSessionRef.current = true;
    // A recap was interrupted by the player speaking — clear its highlight.
    if (recapSkipRef.current === false && recapPlaying) {
      recapSkipRef.current = true;
    }
    addLine("user", transcript);
    pushHistory("user", transcript);
    setSendingSync(true);
    try {
      if (onboardingPhaseRef.current === "pre_core") {
        if (WANTS_RULES_PATTERN.test(transcript)) {
          const reply = await respondAndSpeak(buildRulesThenCoreInstructions());
          addLine("assistant", reply);
          pushHistory("assistant", reply);
          return;
        }
        const coreValue = normalizeCoreValueUtterance(transcript);
        const coreLabel = extractCoreTopicPhrase(coreValue);
        if (isWeakCoreValueLabel(coreLabel)) {
          const reply = await respondAndSpeak(buildClarifyRepeatInstructions(transcript));
          addLine("assistant", reply);
          pushHistory("assistant", reply);
          return;
        }
        onboardingPhaseRef.current = "done";
        bibleRef.current = structuredClone(bibleRef.current);
        bibleRef.current.lastUserUtterance = coreValue;
        bibleRef.current.canon.coreValues[0] = coreValue;
        setBible(bibleRef.current);
        void autosave();
        const reply = await respondAndSpeak(buildCoreValueAcceptedInstructions(coreLabel, playfulness));
        addLine("assistant", reply);
        pushHistory("assistant", reply);
        setBible((b) => ({ ...b, lastAiUtterance: reply }));
        void requestOobBibleUpdate(reply);
        return;
      }

      if (bibleRef.current.turnCount > 0 && WRAP_UP_PATTERN.test(transcript)) {
        addLine("sys", "Heard a wrap-up cue.");
        await finishAndSave();
        return;
      }

      // Let the player CORRECT a mis-heard core value ("no, you got it wrong,
      // change it to beach culture"). Only explicit corrections match (see
      // parseUserCorrectionLabel); ordinary answers pass straight through.
      const correctionLabel = parseUserCorrectionLabel(transcript);
      if (correctionLabel && !isWeakCoreValueLabel(correctionLabel)) {
        const normalized = normalizeCoreValueUtterance(correctionLabel);
        bibleRef.current = structuredClone(bibleRef.current);
        bibleRef.current.canon.coreValues[0] = normalized;
        bibleRef.current.lastUserUtterance = normalized;
        setBible(bibleRef.current);
        void autosave();
        addLine("sys", `Core value corrected to "${extractCoreTopicPhrase(normalized)}".`);
        const reply = await respondAndSpeak(buildCorrectionAckInstructions(extractCoreTopicPhrase(normalized)));
        addLine("assistant", reply);
        pushHistory("assistant", reply);
        setBible((b) => ({ ...b, lastAiUtterance: reply }));
        return;
      }

      const coreValue = String(bibleRef.current.canon.coreValues?.[0] ?? "").trim();
      // Persistent canon summary keeps the model grounded in facts that have
      // scrolled out of the short chat window — the fix for "losing the plot".
      const canonSummary = compactCanonSummary(bibleRef.current);
      const reply = await respondAndSpeak(buildGuidedTurnInstructions(coreValue, playfulness, canonSummary));
      addLine("assistant", reply);
      pushHistory("assistant", reply);
      setBible((b) => ({ ...b, lastAiUtterance: reply, lastUserUtterance: transcript }));
      void requestOobBibleUpdate(reply);
    } catch (e) {
      addLine("sys", `Error: ${String((e as Error)?.message ?? e)}`);
      setSendingSync(false);
      setSpeakingSync(false);
    }
  };

  useEffect(() => {
    const handler = () => {
      if (active) return;
      void start();
    };
    window.addEventListener("society-start", handler);
    return () => window.removeEventListener("society-start", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // "New Game": start a fresh game immediately. Called DIRECTLY (via newGameRef)
  // from GameShell's nav-button React onClick — same synchronous path as the
  // Start button, which is what makes activation reliable (the old raw-window-
  // event + effect indirection intermittently failed to activate on first click).
  const doNewGame = () => {
    // Save the OUTGOING session before wiping it. autosave() captures the
    // current id/bible/images synchronously (its prologue runs before the first
    // await), so firing it here — BEFORE the resets below — persists the old
    // game in the background even though we immediately blank the refs. It
    // self-guards on hasContent, so a fresh/greeting-only session saves nothing.
    void autosave();

    // Reset session REFS only, then call start() — nothing else. This mirrors
    // the Start button (`() => void start()`) as closely as possible, which is
    // the only path that activates reliably on the first click. start()'s "new"
    // branch owns the context reset + audio/mic, and its greeting's speak()
    // already stops any old audio/stream, so no cancelSpeech/closeMic here.
    // Keep this call SYNCHRONOUS (no await) so start() runs in the same tick as
    // the click — awaiting the save here reintroduced the flaky first-click.
    sessionIdRef.current = "";
    bibleRef.current = createEmptyBible();
    imagesRef.current = [];
    historyRef.current = [];
    startModeRef.current = "new";
    recapSkipRef.current = true;
    void start();
  };

  useEffect(() => {
    if (newGameRef) newGameRef.current = doNewGame;
    return () => {
      if (newGameRef) newGameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mode?: string } | undefined;
      if (detail?.mode !== "recap") return;
      startModeRef.current = "recap";
      if (!active) void start();
    };
    window.addEventListener("society-recap", handler);
    return () => window.removeEventListener("society-recap", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const handler = () => {
      startModeRef.current = "continue";
      if (!active) void start();
    };
    window.addEventListener("society-resume", handler);
    return () => window.removeEventListener("society-resume", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const coreValueDisplay = useMemo(
    () => bible.canon.coreValues?.[0] ?? bible.lastUserUtterance ?? "",
    [bible.canon.coreValues, bible.lastUserUtterance]
  );

  const statusText = speaking
    ? "Speaking…"
    : recording
    ? "Listening…"
    : transcribing
    ? "Transcribing…"
    : sending
    ? "Thinking…"
    : active
    ? "Waiting for you to speak"
    : "";

  return (
    <div className="card">
      <div className="kv vcHeaderRow">
        <div className="kv">
          {!active ? (
            <button onClick={() => void start()} disabled={sending}>
              {startLabel}
            </button>
          ) : (
            <button onClick={onStop} disabled={sending}>
              Stop
            </button>
          )}
          {recapPlaying ? (
            <button onClick={onSkipRecap} className="skipRecapBtn" type="button">
              ⏭ Skip recap
            </button>
          ) : null}
          <span className={`statusLight ${active ? "statusLight--on" : "statusLight--off"}`} />
        </div>
      </div>

      <div className="liveTranscript">
        <canvas className="aiWave" ref={waveCanvasRef} width={320} height={80} />
      </div>

      {active ? <small className="muted voiceStatusText">{statusText}</small> : null}

      {micError ? <small className="muted imageError">{micError}</small> : null}
      {ttsError ? <small className="muted imageError">TTS: {ttsError}</small> : null}

      {showSettings ? (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalHeader">
              <strong>Settings (Open Voice)</strong>
              <div className="kv">
                {sessionId ? (
                  <button onClick={onDeleteSession} className="dangerButton">
                    Delete session
                  </button>
                ) : null}
                <button className="modalClose" onClick={onToggleSettings}>
                  X
                </button>
              </div>
            </div>
            <div className="modalBody vcSettingsGrid">
              {sessionId ? (
                <div className="settingsRenameRow">
                  <label className="tag">
                    Session name{" "}
                    <input
                      className="sessionTitleInput"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onRenameSession();
                        }
                      }}
                      placeholder="Session name"
                    />
                  </label>
                  <button onClick={onRenameSession} type="button">
                    Save
                  </button>
                  {lastSaveAt ? (
                    <small className="saveStatus">
                      Saved {lastSaveAt}{lastSaveTitle ? ` — ${lastSaveTitle}` : ""}
                    </small>
                  ) : null}
                </div>
              ) : null}
              {sessionId ? (
                <label className="tag">
                  Core value <input className="sessionTitleInput" value={coreValueDisplay} readOnly />
                </label>
              ) : null}
              <label className="tag">
                Play{" "}
                <select
                  value={playfulness}
                  disabled={active}
                  onChange={(e) => setPlayfulness(Number(e.target.value) as Playfulness)}
                  className="vcFieldSpacing"
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
              <label className="tag">
                Auto images{" "}
                <input
                  type="checkbox"
                  checked={autoImages}
                  onChange={(e) => setAutoImages(e.target.checked)}
                  className="vcFieldSpacing"
                />
              </label>
              <label className="tag">
                Every{" "}
                <select
                  value={autoEveryTurns}
                  onChange={(e) => setAutoEveryTurns(Number(e.target.value))}
                  className="vcFieldSpacing"
                >
                  <option value={1}>1 turn</option>
                  <option value={2}>2 turns</option>
                  <option value={3}>3 turns</option>
                  <option value={4}>4 turns</option>
                </select>
              </label>
              <span className="tag">Brain: OpenRouter (uncensored) · Voice: Pocket-TTS, local &amp; free.</span>

              <details>
                <summary className="muted">Summary so far</summary>
                <div className="card vcSummaryCard">
                  <div className="kv vcSummaryActions">
                    <button onClick={onRecapUpdate} disabled={sending || !sessionId}>
                      Update summary
                    </button>
                    {sessionId ? <button onClick={onDeleteSession}>Delete session</button> : null}
                  </div>
                  {lastSaveAt ? (
                    <small className="muted">
                      Last saved: {lastSaveAt}{lastSaveTitle ? ` — ${lastSaveTitle}` : ""}
                    </small>
                  ) : null}
                  {summary ? <pre>{summary}</pre> : <small className="muted">No summary yet. Press "Update summary".</small>}
                </div>
              </details>

              <details>
                <summary className="muted">Transcript</summary>
                <div className="textChatLog" ref={chatLogRef}>
                  {chat.length === 0 ? (
                    <small className="muted">Nothing said yet.</small>
                  ) : (
                    chat.map((line, i) => (
                      <div key={i} className={`chatBubble chatBubble--${line.role}`}>
                        <span className="chatBubbleText">{line.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
