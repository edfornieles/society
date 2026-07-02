"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bumpTurn, addCanonLines, addOpenThreads, createEmptyBible } from "@/lib/societyBible";
import { useSociety } from "./SocietyContext";
import { saveGame, listGames, deleteGame, getGame } from "@/lib/gameHistory";
import { recapPrompt, finalBreakdownPrompt, recapNarrationPrompt, Playfulness } from "@/lib/prompts";
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
  WANTS_RULES_PATTERN,
  WRAP_UP_PATTERN,
  pickSessionTitle,
  getCoreChoice,
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

export function TextConsoleV2({
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
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [inputText, setInputText] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageStyleGuide, setImageStyleGuide] = useState<string>(DEFAULT_64BIT_STYLE_GUIDE);
  const [lastSaveAt, setLastSaveAt] = useState<string>("");
  const [lastSaveTitle, setLastSaveTitle] = useState<string>("");
  const [editTitle, setEditTitle] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState("");
  const inputTextRef = useRef("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const hasSpokenRef = useRef(false);
  const silenceSinceRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const startModeRef = useRef<"new" | "continue" | "recap">("new");
  const bibleRef = useRef(bible);
  const imagesRef = useRef(images);
  const summaryRef = useRef(summary);
  const sessionIdRef = useRef(sessionId);
  const lastSessionIdRef = useRef(sessionId);
  const autosaveTimerRef = useRef<number | null>(null);
  const lastAutoImageTurnRef = useRef<number>(0);
  const lastAutoImageFailureTurnRef = useRef<number>(-1);
  const onboardingPhaseRef = useRef<"pre_core" | "done">("done");
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);
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
      setActive(false);
      setChat([]);
      historyRef.current = [];
    }
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

  // Real turn-by-turn history, sent alongside a much shorter per-turn system
  // prompt instead of re-deriving "what's been said" into the instructions
  // every call — lets the model track the world like any chat model tracks
  // context. Capped to a rolling window so token cost stays bounded.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  // 12 messages = 6 recent exchanges — enough continuity without letting older
  // (possibly drifted) turns linger and compound. Matches OpenVoiceConsole.
  const MAX_HISTORY_MESSAGES = 12;
  const pushHistory = (role: "user" | "assistant", content: string) => {
    const text = content.trim();
    if (!text) return;
    historyRef.current = [...historyRef.current, { role, content: text }].slice(-MAX_HISTORY_MESSAGES);
  };

  /** Cheap chat-completion equivalent of a realtime response.create. */
  const askModel = async (instructions: string, json = false): Promise<string> => {
    const r = await fetch(withBase("/api/text-turn"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions, json, history: json ? undefined : historyRef.current }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.text) {
      throw new Error(String(data?.error ?? `Text turn failed (${r.status})`));
    }
    const text = String(data.text);
    if (json) return text;
    const cleaned = sanitizeModelReply(text);
    return looksLikeUsableReply(cleaned) ? cleaned : text;
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

  // Same auto-image gating as voice: first image waits for concrete grounded
  // canon, then one every N turns.
  useEffect(() => {
    if (!autoImages) return;
    if (!active) return;
    if (imageBusy) return;
    if (!bible.canon.coreValues[0]) return;
    if (images.length > 0) return;
    if (lastAutoImageFailureTurnRef.current === bible.turnCount) return;
    if (bible.turnCount < 1) return;
    if (!hasConcreteFirstImageAnchor(bible)) return;
    onGenerateImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bible.canon.coreValues[0], bible.lastAiUtterance, bible.turnCount, bible.changelog.length, active, imageBusy, autoImages, images.length]);

  useEffect(() => {
    if (!autoImages) return;
    if (!active) return;
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
  }, [autoImages, autoEveryTurns, bible.turnCount, active, imageBusy, images.length]);

  /** Recap (JSON canon digest) -> final breakdown (JSON permanent record) -> save. */
  const finishAndSave = async () => {
    setSending(true);
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
        setActive(false);
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
      setSending(false);
      setActive(false);
    }
  };

  async function start() {
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
      historyRef.current = [];
    }
    if (!sessionIdRef.current) {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto.randomUUID() as string)
          : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      setSessionId(id);
      sessionIdRef.current = id;
    }

    setActive(true);
    window.dispatchEvent(new Event("society-started"));

    if (effectiveMode === "recap") {
      onboardingPhaseRef.current = "done";
      const captions = imagesRef.current.map((i) => i.caption || i.title || "").filter(Boolean);
      if (imagesRef.current.length > 0) {
        window.dispatchEvent(new CustomEvent("society-recap-slideshow", { detail: { intervalMs: 7000 } }));
      }
      setSending(true);
      try {
        const text = await askModel(`Respond only in English. ${recapNarrationPrompt(bibleRef.current, captions)}`);
        addLine("assistant", text);
        pushHistory("assistant", text);
      } catch (e) {
        addLine("sys", `Recap failed: ${String((e as Error)?.message ?? e)}`);
      } finally {
        setSending(false);
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
      setSending(true);
      try {
        const text = await askModel(buildResumeInstructions(coreValue, recentCanon));
        addLine("assistant", text);
        pushHistory("assistant", text);
        setBible((b) => ({ ...b, lastAiUtterance: text }));
      } catch (e) {
        addLine("sys", `Resume failed: ${String((e as Error)?.message ?? e)}`);
      } finally {
        setSending(false);
      }
      startModeRef.current = "new";
    } else {
      onboardingPhaseRef.current = "pre_core";
      addLine("assistant", GREETING_TEXT);
      pushHistory("assistant", GREETING_TEXT);
    }
  }

  const onStop = () => {
    if (!active || sending) return;
    void finishAndSave();
  };

  const onUndo = () => {
    setBible((prev) => {
      const next = structuredClone(prev);
      next.changelog.pop();
      return next;
    });
    addLine("sys", "Undo: removed last canon line.");
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
    setActive(false);
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
    setSending(true);
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
      setSending(false);
    }
  };

  // Voice-activity detection tuning for auto-stop-on-pause. Silence is judged
  // by RMS amplitude of the raw mic waveform, not volume in dB — cheap and
  // good enough for "has the player stopped talking" at conversational range.
  const VAD_SPEECH_RMS = 0.02;
  const VAD_SILENCE_HOLD_MS = 1100;
  const VAD_MAX_RECORD_MS = 25000;

  /**
   * Speak-to-type: records mic audio, auto-stops on a natural pause (VAD),
   * transcribes via one-shot Whisper (POST /api/transcribe), and sends
   * immediately — no manual Stop/Send needed. Cheap by design: no WebRTC
   * session, no TTS output, unlike the realtime Voice console.
   */
  const startRecording = async () => {
    setMicError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      recordedChunksRef.current = [];

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      hasSpokenRef.current = false;
      silenceSinceRef.current = null;
      recordingStartedAtRef.current = Date.now();

      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => void transcribeRecording();
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      monitorSilence();
    } catch (e) {
      setMicError("Mic access denied or unavailable.");
    }
  };

  const monitorSilence = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.fftSize);

    const tick = () => {
      const analyserNow = analyserRef.current;
      if (!analyserNow) return; // recording was stopped
      analyserNow.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const normalized = (buffer[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const now = Date.now();

      if (rms > VAD_SPEECH_RMS) {
        hasSpokenRef.current = true;
        silenceSinceRef.current = null;
      } else if (hasSpokenRef.current && silenceSinceRef.current === null) {
        silenceSinceRef.current = now;
      }

      const silenceElapsed = silenceSinceRef.current ? now - silenceSinceRef.current : 0;
      const totalElapsed = now - (recordingStartedAtRef.current ?? now);
      if ((hasSpokenRef.current && silenceElapsed >= VAD_SILENCE_HOLD_MS) || totalElapsed >= VAD_MAX_RECORD_MS) {
        stopRecording();
        return;
      }
      vadRafRef.current = requestAnimationFrame(tick);
    };
    vadRafRef.current = requestAnimationFrame(tick);
  };

  const stopRecording = () => {
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setRecording(false);
  };

  const transcribeRecording = async () => {
    const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
    recordedChunksRef.current = [];
    if (blob.size === 0) return;
    setTranscribing(true);
    try {
      const form = new FormData();
      form.set("audio", blob, "speech.webm");
      const r = await fetch(withBase("/api/transcribe"), { method: "POST", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || typeof data?.text !== "string") {
        setMicError(String(data?.error ?? "Transcription failed"));
        return;
      }
      const text = data.text.trim();
      if (!text) return;
      // Whisper hallucinates plausible-sounding boilerplate (URLs, "thank you
      // for watching") on silence/background noise rather than recognizing
      // there's no real speech — discard it rather than treating fabricated
      // text as something the player said.
      if (isSpuriousUserTranscript(text)) {
        addLine("sys", "Ignored a junk transcription (likely background noise) — try speaking again.");
        return;
      }
      // Combine with anything already typed, then send immediately — no
      // manual Send click needed, matching a natural spoken-turn feel.
      // IMPORTANT: sendUserMessage (a network call + chat mutation) must NOT
      // run inside a setState updater — React (StrictMode in dev, and
      // potentially concurrent rendering generally) can invoke an updater
      // more than once, which double-sent every voice turn.
      const combined = inputTextRef.current ? `${inputTextRef.current} ${text}` : text;
      setInputText("");
      void sendUserMessage(combined);
    } catch (e) {
      setMicError(String((e as Error)?.message ?? "Transcription failed"));
    } finally {
      setTranscribing(false);
    }
  };

  const onMicToggle = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  useEffect(() => {
    return () => {
      if (vadRafRef.current) cancelAnimationFrame(vadRafRef.current);
      audioContextRef.current?.close().catch(() => {});
      mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const sendUserMessage = async (raw: string) => {
    const transcript = raw.trim();
    if (!transcript || sending || !active) return;
    addLine("user", transcript);
    pushHistory("user", transcript);
    setInputText("");
    setSending(true);
    try {
      // Note: unlike VoiceConsoleV2, there is no "correction override" here —
      // that mechanism exists to fix ASR mishearing the core value ("no, I
      // said honor, not honesty"). In text mode the player types (or the
      // mic dictates verbatim via Whisper) exactly what they mean, so there's
      // nothing to mishear; the heuristic only produced false positives on
      // ordinary answers that happened to contain "it's"/"its".

      if (onboardingPhaseRef.current === "pre_core") {
        if (WANTS_RULES_PATTERN.test(transcript)) {
          const reply = await askModel(buildRulesThenCoreInstructions());
          addLine("assistant", reply);
          pushHistory("assistant", reply);
          return;
        }
        const coreValue = normalizeCoreValueUtterance(transcript);
        const coreLabel = extractCoreTopicPhrase(coreValue);
        if (isWeakCoreValueLabel(coreLabel)) {
          const reply = await askModel(buildClarifyRepeatInstructions(transcript));
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
        const reply = await askModel(buildCoreValueAcceptedInstructions(coreLabel, playfulness));
        addLine("assistant", reply);
        pushHistory("assistant", reply);
        setBible((b) => ({ ...b, lastAiUtterance: reply }));
        void requestOobBibleUpdate(reply);
        return;
      }

      // Wrap-up detection — same phrasing trigger as voice's Stop flow.
      if (bibleRef.current.turnCount > 0 && WRAP_UP_PATTERN.test(transcript)) {
        addLine("sys", "Heard a wrap-up cue.");
        await finishAndSave();
        return;
      }

      const coreValue = String(bibleRef.current.canon.coreValues?.[0] ?? "").trim();
      const canonSummary = compactCanonSummary(bibleRef.current);
      const reply = await askModel(buildGuidedTurnInstructions(coreValue, playfulness, canonSummary));
      addLine("assistant", reply);
      pushHistory("assistant", reply);
      setBible((b) => ({ ...b, lastAiUtterance: reply, lastUserUtterance: transcript }));
      void requestOobBibleUpdate(reply);
    } catch (e) {
      addLine("sys", `Error: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setSending(false);
    }
  };

  // Welcome-screen "Press Start" CTA and sidebar Start button share this event.
  useEffect(() => {
    const handler = () => {
      if (active) return;
      void start();
    };
    window.addEventListener("society-start", handler);
    return () => window.removeEventListener("society-start", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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
          <button onClick={onUndo}>Undo</button>
          <span className={`statusLight ${active ? "statusLight--on" : "statusLight--off"}`} />
        </div>
      </div>

      <div className="textChatLog" ref={chatLogRef}>
        {chat.length === 0 ? (
          <small className="muted">Press {startLabel} to begin — this is the cheap text dev console.</small>
        ) : (
          chat.map((line, i) => (
            <div key={i} className={`chatBubble chatBubble--${line.role}`}>
              <span className="chatBubbleText">{line.text}</span>
            </div>
          ))
        )}
        {sending ? <div className="chatBubble chatBubble--sys">…</div> : null}
      </div>

      <div className="textInputRow">
        <textarea
          className="textInputBox"
          value={inputText}
          disabled={!active || sending}
          placeholder={active ? "Type your answer…" : "Press Start first"}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendUserMessage(inputText);
            }
          }}
        />
        <button
          onClick={onMicToggle}
          disabled={!active || sending || transcribing}
          className={recording ? "micButtonActive" : ""}
          title="Speak your answer — stops and sends automatically after a pause (Whisper only, no voice reply)"
          type="button"
        >
          {recording ? "🔴 Listening…" : transcribing ? "…" : "🎤"}
        </button>
        <button onClick={() => void sendUserMessage(inputText)} disabled={!active || sending || !inputText.trim()}>
          Send
        </button>
      </div>
      {micError ? <small className="muted imageError">{micError}</small> : null}

      {showSettings ? (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalHeader">
              <strong>Settings (Text mode)</strong>
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
              <span className="tag">Text mode uses gpt-4o-mini — no voice cost.</span>

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
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
