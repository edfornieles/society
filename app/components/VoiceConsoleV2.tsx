"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bumpTurn, addCanonLines, addOpenThreads, createEmptyBible } from "@/lib/societyBible";
import type { SocietyBible } from "@/lib/societyBible";
import { useSociety } from "./SocietyContext";
import { saveGame, listGames, deleteGame, getGame } from "@/lib/gameHistory";
import {
  systemInstructions,
  bibleSummaryForModel,
  oobUpdatePrompt,
  recapPrompt,
  finalBreakdownPrompt,
  imagePromptFromBible,
  recapNarrationPrompt,
  Playfulness,
} from "@/lib/prompts";
import { safeJsonParse, sanitizeUpdate } from "@/lib/guardrails";
import { isSpuriousUserTranscript } from "@/lib/transcriptGuards";
import { normalizeCoreValueUtterance, extractCoreTopicPhrase } from "@/lib/coreValueNormalize";
import { mkSessionUpdate, mkResponseCreate, mkResponseCancel } from "@/lib/realtimeEvents";
import type { GeneratedImage } from "./ImageStrip";

type LogLine = { at: string; dir: "in" | "out" | "sys"; text: string };

type BibleUpdate = {
  addCanon: string[];
  addOpenThreads: string[];
  contradictionsFound: string[];
  reconciliationOptions: string[];
};

const VOICES = ["marin", "alloy", "verse", "aria", "ember"] as const;

const DEFAULT_64BIT_STYLE_GUIDE =
  "64-bit retro pixel art (late PS1/N64-era). Crisp pixels with richer detail, broader palette, subtle dithering, strong silhouettes, readable shapes. Cozy cinematic framing translated into pixel art. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

const IMAGE_SIZE = "1536x1024";
const USER_TURN_SILENCE_MS = 2200;
const USER_TURN_PREFIX_PADDING_MS = 500;
const ENGLISH_ONLY_INSTRUCTION =
  "ABSOLUTE RULE: Respond ONLY in English (American or British wording). Never speak Russian, Ukrainian, or any Cyrillic-script language; never German, Dutch, French, Spanish, Italian, Portuguese, or any other language — no code-switching, no mirroring the user's language, no foreign filler words. Do not use Cyrillic in speech. Stay in English even if the user has a non-English accent. No exceptions.";

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, "").replace(/\s+/g, " ").trim();
}

function isLikelyEcho(userText: string, assistantText: string) {
  const u = normalizeText(userText);
  const a = normalizeText(assistantText);
  if (!u || !a) return false;
  if (u.length < 12) return false;
  return a.includes(u) || u.includes(a);
}

function formatSessionTitle(coreChoice: string) {
  const collapsed = extractCoreTopicPhrase(
    normalizeCoreValueUtterance(coreChoice.replace(/\s+/g, " ").trim())
  );
  const cleaned = collapsed.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const truncated = cleaned.length > 48 ? `${cleaned.slice(0, 45)}…` : cleaned;
  const lowered = truncated.toLowerCase();
  const genericStarters = ["the society", "every", "dogs are", "agriculture is", "armor making is", "fashion shapes"];
  let core = truncated;
  for (const starter of genericStarters) {
    if (lowered.startsWith(starter)) {
      core = truncated
        .slice(starter.length)
        .replace(/^(\s+is|\s+are|\s+being|\s+places|\s+values|\s+worships)\b/i, "")
        .replace(/^[^a-z0-9]+/i, "")
        .trim();
      break;
    }
  }
  const words = core.split(" ").filter(Boolean).slice(0, 3);
  return words.join(" ");
}

function pickSessionTitle(bible: SocietyBible, parsedCore?: string, parsedTitle?: string) {
  const core0 = String(parsedCore ?? bible?.canon?.coreValues?.[0] ?? getCoreChoice(bible) ?? "").trim();
  const formatted = formatSessionTitle(core0 || "");
  if (formatted) return formatted;
  if (parsedTitle) return formatSessionTitle(String(parsedTitle).trim());

  const genericPattern = /started a session|session started|participants have started/i;
  const firstCanon = bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((entry) => entry && !genericPattern.test(entry));

  return formatSessionTitle(firstCanon || "") || `Society ${new Date().toLocaleString()}`;
}

function getCoreChoice(bible: SocietyBible) {
  const explicit = String(bible?.canon?.coreValues?.[0] ?? "").trim();
  const lastUser = String(bible?.lastUserUtterance ?? "").trim();
  const genericPattern = /started a session|session started|participants have started|society places|central value|shapes all aspects of life/i;
  if (explicit) return explicit;
  if (lastUser && !genericPattern.test(lastUser)) return lastUser;
  const firstCanon = bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((entry) => entry && !genericPattern.test(entry));
  return firstCanon || "";
}

export function VoiceConsoleV2({
  showRules,
  showSettings,
  onToggleSettings,
  startLabel,
  resumeMode,
  voice,
  setVoice,
  playfulness,
  setPlayfulness,
  autoImages,
  setAutoImages,
  autoEveryTurns,
  setAutoEveryTurns,
}: {
  showRules: boolean;
  showSettings: boolean;
  onToggleSettings: () => void;
  startLabel: string;
  resumeMode: "new" | "continue" | "recap";
  voice: (typeof VOICES)[number];
  setVoice: (v: (typeof VOICES)[number]) => void;
  playfulness: Playfulness;
  setPlayfulness: (v: Playfulness) => void;
  autoImages: boolean;
  setAutoImages: (v: boolean) => void;
  autoEveryTurns: number;
  setAutoEveryTurns: (v: number) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);

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
  const [log, setLog] = useState<LogLine[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageStyleGuide, setImageStyleGuide] = useState<string>(DEFAULT_64BIT_STYLE_GUIDE);
  const [players, setPlayers] = useState<number>(2);
  const [lastSaveAt, setLastSaveAt] = useState<string>("");
  const [lastSaveTitle, setLastSaveTitle] = useState<string>("");
  const [editTitle, setEditTitle] = useState<string>("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pausedRef = useRef(false);
  const aiSpeakingRef = useRef(false);
  const aiSpeechTimeoutRef = useRef<number | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveRafRef = useRef<number | null>(null);

  const lastAssistantTranscriptRef = useRef<string>("");
  const lastAutoImageTurnRef = useRef<number>(0);
  const startModeRef = useRef<"new" | "continue" | "recap">("new");
  const bibleRef = useRef(bible);
  const imagesRef = useRef(images);
  const summaryRef = useRef(summary);
  const sessionIdRef = useRef(sessionId);
  const lastSessionIdRef = useRef(sessionId);
  const autosaveTimerRef = useRef<number | null>(null);
  const pendingFinalBreakdownRef = useRef(false);
  const lastUserTranscriptRef = useRef<string>("");
  const lastAssistantAtRef = useRef<number>(0);
  const resumeAfterConnectRef = useRef(false);
  // "pre_core" = before the player has answered the core question (onboarding)
  // "done"     = normal gameplay, server auto-responses are active
  const onboardingPhaseRef = useRef<"pre_core" | "done">("done");
  /** Bumps whenever `stop()` runs so in-flight `start()` can abort after async gaps (e.g. getUserMedia). */
  const startGenRef = useRef(0);
  /** One-time pointer listener if the browser blocks remote audio.play() (autoplay policy). */
  const audioUnlockListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    bibleRef.current = bible;
  }, [bible]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

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

  const setMicEnabled = (enabled: boolean) => {
    const local = localStreamRef.current;
    if (!local) return;
    local.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  };

  const releaseMicAfterAssistant = () => {
    aiSpeakingRef.current = false;
    if (aiSpeechTimeoutRef.current) {
      window.clearTimeout(aiSpeechTimeoutRef.current);
      aiSpeechTimeoutRef.current = null;
    }
    aiSpeechTimeoutRef.current = window.setTimeout(() => {
      if (!pausedRef.current) {
        setMicEnabled(true);
      }
    }, 250);
  };

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const existing = await getGame(sessionId);
      if (existing?.title) {
        setEditTitle(existing.title);
      }
    })().catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    startModeRef.current = resumeMode;
  }, [resumeMode]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    // Reset any in-flight UI indicators when switching sessions.
    setImageBusy(false);
  }, [sessionId]);

  useEffect(() => {
    if (!lastSessionIdRef.current) {
      lastSessionIdRef.current = sessionId;
      return;
    }
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      if (connected || connecting) {
        stop();
      }
      setLiveTranscript("");
      setLog([]);
    }
  }, [sessionId, connected, connecting]);

  const addLog = (dir: LogLine["dir"], text: string) => {
    setLog((prev) => [...prev.slice(-250), { at: new Date().toLocaleTimeString(), dir, text }]);
  };

  const tools = useMemo(() => {
    // Tools are optional in this starter. We also do a robust out-of-band JSON update after each assistant turn.
    // If the model calls these tools, we log it; the "real" canon source of truth is still the Society Bible.
    return [
      {
        type: "function",
        name: "society_propose_bible_update",
        description: "Propose small canon additions and open threads for the Society Bible. Keep it consistent.",
        parameters: {
          type: "object",
          properties: {
            addCanon: { type: "array", items: { type: "string" } },
            addOpenThreads: { type: "array", items: { type: "string" } },
            contradictionsFound: { type: "array", items: { type: "string" } },
            reconciliationOptions: { type: "array", items: { type: "string" } },
          },
          required: ["addCanon", "addOpenThreads", "contradictionsFound", "reconciliationOptions"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "society_propose_image_scene",
        description:
          "Propose an image scene tied to concrete canon from this session (named rituals, objects, places from the Society Bible). Do not suggest generic civic or fantasy filler unrelated to established facts.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            caption: { type: "string" },
            styleGuide: { type: "string" },
            prompt: { type: "string" },
            negativePrompt: { type: "string" },
          },
          required: ["title", "prompt", "negativePrompt"],
          additionalProperties: false,
        },
      },
    ];
  }, []);

  const sendEvent = (evt: any) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(evt));
    addLog("out", JSON.stringify(evt));
  };

  const makeTurnDetection = (createResponse: boolean) => ({
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: USER_TURN_PREFIX_PADDING_MS,
    silence_duration_ms: USER_TURN_SILENCE_MS,
    create_response: createResponse,
    interrupt_response: true,
  });

  const enableAutoResponse = () => {
    sendEvent(
      mkSessionUpdate({
        audio: { input: { turn_detection: makeTurnDetection(true) } },
      })
    );
  };

  /** Fire-and-forget structured log entry to data/logs/{sessionId}.log */
  const debugLog = (event: string, data?: Record<string, unknown>) => {
    const id = sessionIdRef.current || "pre-session";
    fetch("/api/debug-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, event, data }),
    }).catch(() => {});
  };

  const sendSessionInstructions = (createResponse = true) => {
    const coreValue = bibleRef.current?.canon?.coreValues?.[0] ?? "";
    // Pass coreValue into systemInstructions so the prompt switches from
    // "session start / ask the core question" to "gameplay mode" once the
    // foundation is established. This prevents the model from treating every
    // turn as if it's still waiting for the player to name their core value.
    const sessionInstructions = `${systemInstructions(playfulness, coreValue || undefined)}\n\n${bibleSummaryForModel(bibleRef.current)}`;
    debugLog("SESSION_UPDATE_SENT", {
      createResponse: String(createResponse),
      coreValue: coreValue || "(none)",
      instructionsPreview: sessionInstructions.slice(0, 800),
    });
    // Note: session.update does NOT accept "type" or "model" fields — those
    // are creation-only. Including them can cause the server to reject the
    // entire update, which was silently discarding our instructions.
    sendEvent(
      mkSessionUpdate({
        output_modalities: ["audio"],
        audio: {
          input: {
            turn_detection: makeTurnDetection(createResponse),
          },
        },
        instructions: sessionInstructions,
        tools,
        tool_choice: "auto",
      })
    );
  };

  async function start() {
    if (connecting || connected) {
      stop();
    }
    const myGen = ++startGenRef.current;
    setConnecting(true);
    setLiveTranscript("");
    setPaused(false);
    window.dispatchEvent(new Event("society-started"));
    try {
      // When explicitly starting a new game, reset stale refs immediately so we
      // never accidentally fall into "continue" mode due to ref/state lag.
      if (startModeRef.current === "new") {
        sessionIdRef.current = "";
        bibleRef.current = createEmptyBible();
        imagesRef.current = [];
      }

      // Only auto-switch to continue if there is an explicit session ID already loaded.
      if (
        startModeRef.current === "new" &&
        sessionIdRef.current &&
        (imagesRef.current.length > 0 || bibleRef.current.turnCount > 0)
      ) {
        startModeRef.current = "continue";
      }
      if (startModeRef.current === "continue" && !sessionIdRef.current) {
        setConnecting(false);
        window.setTimeout(() => start(), 120);
        return;
      }
      if (!sessionIdRef.current) {
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? (crypto.randomUUID() as string)
            : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        setSessionId(id);
        sessionIdRef.current = id;
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio playback
      const audio = new Audio();
      audio.autoplay = true;
      // Safari / iOS: inline playback helps some builds route to speaker instead of silent failure.
      try {
        (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      } catch {
        /* ignore */
      }
      remoteAudioRef.current = audio;
      pc.ontrack = (e) => {
        if (audioUnlockListenerRef.current) {
          try {
            window.removeEventListener("pointerdown", audioUnlockListenerRef.current);
          } catch {
            /* ignore */
          }
          audioUnlockListenerRef.current = null;
        }
        audio.srcObject = e.streams[0];
        void audio
          .play()
          .then(() => {
            addLog("sys", "Remote voice audio playing.");
          })
          .catch(() => {
            addLog(
              "sys",
              "Speaker blocked by browser autoplay rules — tap or click anywhere once to hear the AI voice."
            );
            const unlock = () => {
              void audio.play().catch(() => {});
              window.removeEventListener("pointerdown", unlock);
              audioUnlockListenerRef.current = null;
            };
            audioUnlockListenerRef.current = unlock;
            window.addEventListener("pointerdown", unlock, { passive: true });
          });
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        audioContextRef.current = ctx;
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        const source = ctx.createMediaStreamSource(e.streams[0]);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const canvas = waveCanvasRef.current;
        if (canvas) {
          const draw = () => {
            analyser.getByteFrequencyData(dataArray);
            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return;
            const width = canvas.width;
            const height = canvas.height;
            ctx2d.clearRect(0, 0, width, height);
            const barCount = 36;
            const gap = 2;
            const step = Math.max(1, Math.floor(dataArray.length / barCount));
            const barWidth = Math.max(4, Math.floor(width / barCount) - gap);
            const totalWidth = barCount * barWidth + (barCount - 1) * gap;
            const offsetX = Math.max(0, Math.floor((width - totalWidth) / 2));
            const midY = Math.floor(height / 2);
            const activeCount = 34;
            const centerOffset = (barCount - 1) / 2;
            const radius = Math.max(1, activeCount / 2);
            for (let i = 0; i < barCount; i += 1) {
              const distance = Math.abs(i - centerOffset);
              const sampleIndex = Math.min(
                dataArray.length - 1,
                Math.floor((distance / radius) * (dataArray.length - 1))
              );
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
            waveRafRef.current = requestAnimationFrame(draw);
          };
          draw();
        }
      };

      // Local mic
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (myGen !== startGenRef.current) {
        ms.getTracks().forEach((t) => t.stop());
        setConnecting(false);
        return;
      }
      localStreamRef.current = ms;
      pc.addTrack(ms.getAudioTracks()[0], ms);

      // Data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        addLog("sys", "Data channel open — waiting for session.created before sending config.");
        setConnected(true);
        setConnecting(false);
        // Set the onboarding phase now so it's ready when session.created fires.
        const isNewGame = startModeRef.current === "new";
        if (isNewGame) {
          onboardingPhaseRef.current = "pre_core";
        } else {
          onboardingPhaseRef.current = "done";
        }
        // Do NOT send session.update or response.create here.
        // The server hasn't confirmed the session is ready yet.
        // All initialisation happens in the session.created handler below.
      };

      dc.onmessage = (e) => handleServerEvent(e.data);

      pc.onconnectionstatechange = () => {
        addLog("sys", `pc.connectionState=${pc.connectionState}`);
        if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
          stop();
        }
      };

      // Offer/Answer exchange via your server (unified interface)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(`/api/realtime-session?voice=${encodeURIComponent(voice)}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });

      if (myGen !== startGenRef.current) {
        setConnecting(false);
        return;
      }

      if (!sdpResp.ok) {
        const err = await sdpResp.text();
        throw new Error(err);
      }

      const answerSdp = await sdpResp.text();
      if (myGen !== startGenRef.current) {
        setConnecting(false);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      addLog("sys", "WebRTC connected; waiting for session.created...");
      setConnecting(false);
    } catch (err: any) {      setConnecting(false);
      addLog("sys", `Start error: ${String(err?.message ?? err)}`);
      stop();
    }
  }

  function stop() {
    startGenRef.current += 1;
    if (audioUnlockListenerRef.current) {
      try {
        window.removeEventListener("pointerdown", audioUnlockListenerRef.current);
      } catch {
        /* ignore */
      }
      audioUnlockListenerRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
    setStopping(false);
    setPaused(false);
    if (aiSpeechTimeoutRef.current) {
      window.clearTimeout(aiSpeechTimeoutRef.current);
      aiSpeechTimeoutRef.current = null;
    }
    aiSpeakingRef.current = false;
    const dc = dcRef.current;
    if (dc) {
      try { dc.close(); } catch {}
      dcRef.current = null;
    }
    const pc = pcRef.current;
    if (pc) {
      try { pc.close(); } catch {}
      pcRef.current = null;
    }
    const audio = remoteAudioRef.current;
    if (audio) {
      try { audio.srcObject = null; } catch {}
      remoteAudioRef.current = null;
    }
    if (waveRafRef.current) {
      cancelAnimationFrame(waveRafRef.current);
      waveRafRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }
    drawWaveBaseline();
    const local = localStreamRef.current;
    if (local) {
      local.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    addLog("sys", "Stopped.");
  }

  const autosave = async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    const bibleToSave = bibleRef.current;
    const imagesToSave = imagesRef.current;
    // Require at least the core value OR some gameplay to avoid saving empty shells.
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
      addLog("sys", `Save failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const onDeleteSession = async () => {
    if (!sessionIdRef.current) return;
    const id = sessionIdRef.current;
    try {
      await deleteGame(id);
      setHistory(await listGames());
      window.dispatchEvent(new Event("society-sessions-updated"));
    } catch {
      // ignore delete failures
    }
    sessionIdRef.current = "";
    setSessionId("");
    setSummary("");
    setFinalRecord("");
    setImages([]);
    setBible(createEmptyBible());
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
      // ignore rename failures
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
  }, [bible, images, summary, sessionId]);

  // --- Server event handling --------------------------------------------------

  const handleServerEvent = async (raw: string) => {
    let evt: any = null;
    try { evt = JSON.parse(raw); } catch { return; }

    // Keep the log readable
    if (evt?.type) addLog("in", `${evt.type}`);

    // Log every event type to disk so we can see exactly what the server sends.
    // Once we've confirmed the correct event names we can remove this.
    if (evt?.type && !evt.type.startsWith("response.output_audio_transcript.delta")) {
      debugLog("SERVER_EVENT", { type: evt.type });
    }

    if (evt.type === "error") {
      // If streaming fails mid-response, don't leave mic muted.
      releaseMicAfterAssistant();
      addLog("sys", `Server error: ${JSON.stringify(evt?.error ?? evt)}`);
      return;
    }

    // -----------------------------------------------------------------------
    // session.created — the server has confirmed the session is live.
    // THIS is the right moment to push session.update and the opening
    // response.create. Sending them in dc.onopen (before this event) causes
    // them to be silently dropped because the session isn't initialised yet.
    // -----------------------------------------------------------------------
    if (evt.type === "session.created") {
      addLog("sys", "session.created — pushing config and opening prompt.");
      const effectiveMode = startModeRef.current;
      const isNewGame = effectiveMode === "new";
      debugLog("SESSION_CREATED", {
        mode: effectiveMode,
        sessionId: sessionIdRef.current,
        coreValue: bibleRef.current?.canon?.coreValues?.[0] || "(none)",
        onboardingPhase: onboardingPhaseRef.current,
      });

      // Cancel any default auto-response the server fires in the brief window
      // between session.created and our session.update being processed.
      // Without this, the model says "Hey there! What's on your mind?" before
      // our instructions arrive, and our real greeting gets queued then dropped.
      sendEvent(mkResponseCancel());

      if (isNewGame) {
        sendSessionInstructions(false); // create_response:false during onboarding
      } else {
        sendSessionInstructions(true);
      }

      // Small delay so session.update is fully processed by the server before
      // we send response.create. Without this, the response.create can fire
      // before our instructions are applied and the model uses default behaviour.
      await new Promise((r) => window.setTimeout(r, 450));

      if (effectiveMode === "recap") {
        const captions = imagesRef.current.map((i) => i.caption || i.title || "").filter(Boolean);
        if (imagesRef.current.length > 0) {
          window.dispatchEvent(
            new CustomEvent("society-recap-slideshow", { detail: { intervalMs: 7000 } })
          );
        }
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions: `${ENGLISH_ONLY_INSTRUCTION} ${recapNarrationPrompt(bibleRef.current, captions)}`,
            metadata: { topic: "recap_spoken" },
          })
        );
        startModeRef.current = "continue";
      } else if (effectiveMode === "continue") {
        const resumeBible = bibleRef.current;
        const coreValue = resumeBible.canon.coreValues?.[0] || resumeBible.lastUserUtterance || "";
        const recentCanon =
          resumeBible.changelog
            .slice()
            .sort((a, b) => a.turn - b.turn)
            .slice(-8)
            .map((c) => `- ${c.entry}`)
            .join("\n") || "- (none yet)";
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions: `${ENGLISH_ONLY_INSTRUCTION}

You are resuming an existing Society session. Treat everything below as hard canon — do NOT invent or contradict it.

CORE VALUE: ${coreValue || "(not yet set)"}

ESTABLISHED CANON:
${recentCanon}

Your job:
1. Welcome the player back in one warm sentence.
2. Briefly remind them of the core value in one sentence, using only the canon above.
3. Ask one focused question (2–3 options) to continue building. Do not invent new facts.
Keep it short and speakable.`,
            metadata: { topic: "resume" },
          })
        );
        startModeRef.current = "new";
      } else {
        // New game — name the game in English, then ask the core question.
        const greetingInstructions = `${ENGLISH_ONLY_INSTRUCTION}

You are the voice of the spoken improv worldbuilding game "Society" (one word: Society).

Your first sentence MUST do all of this in English only:
- Name the activity: say it is the "Society" worldbuilding game (or "Society" spoken worldbuilding game).
- Say you are the player's Society co-creator for this session.

Example shape (wording can vary slightly but keep every requirement): "Hi — I'm your Society co-creator; we're playing the Society worldbuilding game together."

Immediately after that sentence, say THESE EXACT WORDS and nothing else:
"What's the most important thing in this society? Everything else will follow from it."

Stop speaking after that quoted sentence and wait for the player's answer.

Rules:
- Do NOT speak any language except English. Never Russian, Ukrainian, or German — English only for every word.
- Do NOT ask about genres, types, or aesthetics (no futuristic, medieval, etc.).
- Do NOT offer categories or examples of society types.
- Do NOT paraphrase or reword the quoted question above — say it verbatim after your intro sentence.
- If the player says they want to know the rules first, explain briefly (yes-and per turn, one concrete fact, Mirror → Extend → Prompt format), then ask the exact same quoted question again.`;
        debugLog("RESPONSE_CREATE_SENT", { topic: "greeting", instructions: greetingInstructions });
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions: greetingInstructions,
            metadata: { topic: "greeting" },
          })
        );
      }
      return;
    }

    // Transcript deltas (audio transcript)
    if (evt.type === "response.output_audio_transcript.delta") {
      if (!aiSpeakingRef.current) {
        aiSpeakingRef.current = true;
        setMicEnabled(false);
      }
      if (aiSpeechTimeoutRef.current) {
        window.clearTimeout(aiSpeechTimeoutRef.current);
        aiSpeechTimeoutRef.current = null;
      }
      const delta = evt?.delta ?? "";
      setLiveTranscript((t) => t + delta);
      return;
    }

    // User transcript deltas — correct event names for gpt-realtime model
    if (evt.type === "conversation.item.input_audio_transcription.delta") {
      const delta = evt?.delta ?? "";
      lastUserTranscriptRef.current += delta;
      return;
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(evt?.transcript ?? lastUserTranscriptRef.current ?? "").trim();
      lastUserTranscriptRef.current = "";

      if (transcript && isSpuriousUserTranscript(transcript)) {
        addLog(
          "sys",
          "Ignored junk transcription (often another tab, meeting app, or a URL). Pause other audio and say your answer again."
        );
        return;
      }

      debugLog("USER_SPOKE", {
        transcript,
        onboardingPhase: onboardingPhaseRef.current,
        coreValue: bibleRef.current?.canon?.coreValues?.[0] || "(none)",
      });

      // --- Onboarding intercept ---
      // While in pre_core phase, the server is NOT auto-creating responses.
      // We manually dispatch the right response based on what the player said.
      if (onboardingPhaseRef.current === "pre_core" && transcript) {
        const wantsRules = /\b(rules?|how (does|do) it work|explain|tell me|walk me through|what('s| is) (the game|it about)|how to play)\b/i.test(transcript);

        if (wantsRules) {
          // Player wants rules — explain them, then ask the core question again.
          // Stay in pre_core phase so their NEXT response is also intercepted.
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions: `${ENGLISH_ONLY_INSTRUCTION} The player wants to know how the game works. Explain in 2–3 short sentences: players trade yes-and statements building a fictional society one fact at a time; your turn is always Mirror (echo back) → Extend (add one concrete consequence) → Prompt (one question with 2–3 options). Then immediately ask EXACTLY this: "So — what's the most important thing in this society? Everything else will follow from it." STOP there and wait.`,
              metadata: { topic: "rules_then_core" },
            })
          );
        } else {
          // Player answered the core question — save it to the bible immediately
          // and kick off the first AI gameplay turn.
          onboardingPhaseRef.current = "done";

          const coreValue = normalizeCoreValueUtterance(transcript);
          const coreLabel = extractCoreTopicPhrase(coreValue);

          // Update the ref synchronously so sendSessionInstructions picks up
          // the core value immediately (setState is async and won't update the
          // ref until the next render cycle).
          bibleRef.current = structuredClone(bibleRef.current);
          bibleRef.current.lastUserUtterance = coreValue;
          bibleRef.current.canon.coreValues[0] = coreValue;
          setBible(bibleRef.current);

          debugLog("CORE_VALUE_ACCEPTED", { coreValue, coreLabel });

          // Update system prompt with the core value baked in, but keep
          // create_response: false so the server doesn't fire a VAD auto-response
          // before our explicit core_value_accepted response.create lands.
          // Auto-responses are enabled in response.done after core_value_accepted completes.
          sendSessionInstructions(false);

          // Cancel any stray auto-response just in case.
          sendEvent(mkResponseCancel());

          const cvaInstructions = `${ENGLISH_ONLY_INSTRUCTION}

CORE VALUE JUST ESTABLISHED: "${coreLabel}"

This is the single most important thing in this society. Every word you say must be rooted in "${coreLabel}" specifically — not in general observations about "${coreLabel}" in the abstract.
You MUST use the player's exact term "${coreLabel}" in Part 1 — never replace it with a synonym (e.g. if the term is vanity, do not say beauty, appearance, or looks).

Respond in EXACTLY this three-part structure:

PART 1 — Mirror (one sentence, max 12 words):
Acknowledge "${coreLabel}" directly as the foundation of this society. Do NOT say "${coreLabel} is important" or "${coreLabel} is central" — that is generic. Instead say something like: "${coreLabel} — so in this place, that's the bedrock everything else is built on."

PART 2 — Extend (1–2 sentences):
Name ONE specific, concrete, surprising thing that happens in daily life BECAUSE "${coreLabel}" is the most important thing. Give it a name, a ritual, an object, a rule, a role. It must be a fact that could ONLY exist in a society where "${coreLabel}" is the foundation.
WRONG: "${coreLabel} is deeply valued here."
RIGHT: (example for "art") "Every citizen is assigned a color at birth — a pigment that becomes their medium, their identity, their legal name."

PART 3 — Prompt (one question with 2–3 options):
Ask ONE question with 2–3 choices that could ONLY make sense if "${coreLabel}" is the foundation. The options should force a real revealing choice about how this society works.

Keep it short and speakable. Do NOT say the words "mirror", "extend", or "prompt".`;
          debugLog("RESPONSE_CREATE_SENT", { topic: "core_value_accepted", instructions: cvaInstructions });
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions: cvaInstructions,
              metadata: { topic: "core_value_accepted" },
            })
          );
        }
        return;
      }

      // --- Wrap-up detection ---
      // If the player says something like "let's wrap up" during gameplay,
      // trigger the same final-breakdown flow as pressing Stop.
      const wrapUpPattern = /\b(wrap(ping)? up|let'?s (finish|end|stop|wrap)|that'?s (enough|all|it)|end (the game|the session|it here)|finish(ed)?|i'?m done|we'?re done|stop (the game|playing)|that'?s a wrap)\b/i;
      if (
        onboardingPhaseRef.current === "done" &&
        transcript &&
        bibleRef.current.turnCount > 0 &&
        wrapUpPattern.test(transcript)
      ) {
        setStopping(true);
        pendingFinalBreakdownRef.current = true;
        sendEvent(
          mkResponseCreate({
            conversation: "none",
            metadata: { topic: "recap" },
            output_modalities: ["text"],
            instructions: `Respond only in English. ${recapPrompt(bibleRef.current)}`,
          })
        );
        return;
      }

      const genericPattern = /started a session|session started|participants have started|society places|society values|central value|core value|central core|shapes all aspects|all other aspects|emerge|game is called society|society is called|dive (straight )?in|let'?s (dive|start|go|begin)|what are the rules|how do(es)? it work|tell me the rules/i;
      const tooSoon = Date.now() - lastAssistantAtRef.current < 5000;
      if (
        transcript &&
        !genericPattern.test(transcript) &&
        !isLikelyEcho(transcript, lastAssistantTranscriptRef.current) &&
        !tooSoon
      ) {
        const coreValue = normalizeCoreValueUtterance(transcript);
        setBible((b) => {
          const next = structuredClone(b);
          next.lastUserUtterance = coreValue;
          if (!next.canon.coreValues[0]) {
            next.canon.coreValues[0] = coreValue;
          }
          return next;
        });
      }

      // Safety net: if auto-responses are active (create_response: true) but the
      // core value still isn't set after the player speaks, re-send a targeted
      // response.create to prevent the server generating a generic reply.
      if (
        transcript &&
        !tooSoon &&
        !bibleRef.current.canon.coreValues[0] &&
        !genericPattern.test(transcript) &&
        !isLikelyEcho(transcript, lastAssistantTranscriptRef.current)
      ) {
        const coreValue = normalizeCoreValueUtterance(transcript);
        const coreLabel = extractCoreTopicPhrase(coreValue);
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions: `${ENGLISH_ONLY_INSTRUCTION} The player has just named the most important thing in their society: "${coreLabel}". Treat this as the society's core value — it is now hard canon. Mirror it back warmly in one sentence. Then extend with one concrete, sensory consequence of that value in daily life (1–2 sentences). Then ask one focused follow-up question with 2–3 options to continue building the society. Keep it short and speakable.`,
            metadata: { topic: "core_value_accepted" },
          })
        );
      }
      return;
    }

    if (evt.type === "response.output_audio_transcript.done") {
      const transcript = evt?.transcript ?? liveTranscript;
      lastAssistantTranscriptRef.current = transcript;
      lastAssistantAtRef.current = Date.now();
      releaseMicAfterAssistant();
      setBible((b) => ({ ...b, lastAiUtterance: transcript }));
      setLiveTranscript("");

      debugLog("AI_SPOKE", {
        transcript,
        topic: evt?.response?.metadata?.topic ?? "(auto-response)",
        coreValue: bibleRef.current?.canon?.coreValues?.[0] || "(none)",
        onboardingPhase: onboardingPhaseRef.current,
      });

      // After the model speaks, we do an out-of-band JSON update to propose canon changes.
      // This avoids tool-calling interrupting speech.
      await requestOobBibleUpdate(transcript);
      return;
    }

    // Final response object (can also carry function calls)
    if (evt.type === "response.done") {
      // Safety net: transcript.done can occasionally be skipped.
      releaseMicAfterAssistant();
      // If this was our recap or OOB update, it'll have metadata.topic.
      const topic = evt?.response?.metadata?.topic;
      debugLog("RESPONSE_DONE", {
        topic: topic ?? "(no topic)",
        status: evt?.response?.status ?? "?",
        onboardingPhase: onboardingPhaseRef.current,
        coreValue: bibleRef.current?.canon?.coreValues?.[0] || "(none)",
      });

      // Handle function calling outputs if present.
      const output = evt?.response?.output ?? [];
      for (const item of output) {
        if (item?.type === "function_call") {
          await handleFunctionCall(item);
        }
      }

      // Enable auto-responses and push full gameplay instructions once the
      // first "Society" turn completes. We keep create_response: false until
      // this point so the server can't fire a stale VAD response before our
      // explicit response.create lands.
      if (topic === "core_value_accepted" || topic === "rules_then_core") {
        sendSessionInstructions(true);
      }

      if (topic === "recap") {
        const text = extractTextFromResponse(evt);
        const parsed = safeJsonParse<any>(text);
        const canonRecap: string[] = Array.isArray(parsed?.canonRecap)
          ? (parsed.canonRecap as unknown[]).map((v) => String(v)).slice(0, 16)
          : [];
        const openThreads: string[] = Array.isArray(parsed?.openThreads)
          ? (parsed.openThreads as unknown[]).map((v) => String(v)).slice(0, 12)
          : [];
        const nextMoves: string[] = Array.isArray(parsed?.nextMoves)
          ? (parsed.nextMoves as unknown[]).map((v) => String(v)).slice(0, 8)
          : [];

        if (canonRecap.length || openThreads.length || nextMoves.length) {
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
          setSummary(md);
          summaryRef.current = md;
          addLog("sys", "Generated summary so far.");
          window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: "Summary updated" } }));
        } else {
          setSummary(text);
          summaryRef.current = text;
          addLog("sys", `Summary (raw): ${text.slice(0, 240)}`);
          window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: "Summary updated" } }));
        }
        if (pendingFinalBreakdownRef.current) {
          pendingFinalBreakdownRef.current = false;
          sendEvent(
            mkResponseCreate({
              conversation: "none",
              metadata: { topic: "final_breakdown" },
              output_modalities: ["text"],
              instructions: `${ENGLISH_ONLY_INSTRUCTION}\n\n${finalBreakdownPrompt(bibleRef.current)}`,
            })
          );
        }
      }

      // bible_update is now handled by /api/bible-update via requestOobBibleUpdate (direct fetch).

      if (topic === "final_breakdown") {
        const text = extractTextFromResponse(evt);
        const parsed = safeJsonParse<any>(text);
        const pretty = parsed ? JSON.stringify(parsed, null, 2) : text;
        setFinalRecord(pretty);
        addLog("sys", "Saved session record.");
        // Persist to history (IndexedDB) so the user can revisit later.
        try {
          const bibleToSave = bibleRef.current;
          const imagesToSave = imagesRef.current;
          const id =
            sessionIdRef.current ||
            (typeof crypto !== "undefined" && "randomUUID" in crypto
              ? (crypto.randomUUID() as string)
              : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`);
          // Name sessions after the "most important thing" (usually the top core value).
          const coreChoice = getCoreChoice(bibleToSave);
          if (!coreChoice) {
            addLog("sys", "Skipped save: core value not set yet.");
            stop();
            return;
          }
          const title = pickSessionTitle(bibleToSave, String(parsed?.core_values?.[0] ?? "").trim(), String(parsed?.title ?? "").trim());
          const existing = await getGame(id);
          await saveGame({
            id,
            createdAt: existing?.createdAt ?? Date.now(),
            title,
            titleIsCustom: existing?.titleIsCustom ?? false,
            finalRecordText: pretty,
            summary: summaryRef.current,
            bible: bibleToSave,
            images: imagesToSave,
          });
          window.dispatchEvent(new Event("society-sessions-updated"));
          setHistory(await listGames());
          setLastSaveAt(new Date().toLocaleString());
          setLastSaveTitle(title);
          window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: `Saved: ${title}` } }));
        } catch {
          // ignore persistence errors (private browsing, storage quota, etc.)
        }

        stop();
        window.dispatchEvent(new Event("society-reset"));
      }

      // image_scene is now handled by /api/image-scene via onGenerateImage (direct fetch).

      return;
    }
  };

  function extractTextFromResponse(evt: any): string {
    // response.output may include content parts; keep this defensive.
    const out = evt?.response?.output ?? [];
    let combined = "";
    for (const o of out) {
      if (o?.type === "message") {
        const content = o?.content ?? [];
        for (const c of content) {
          if (typeof c?.text === "string") combined += c.text;
        }
      }
      // Some servers may put text directly on output items (rare).
      if (typeof o?.text === "string") combined += o.text;
    }
    return combined.trim();
  }

  async function handleFunctionCall(item: any) {
    const name = item?.name;
    const call_id = item?.call_id;
    const args = safeJsonParse<any>(item?.arguments ?? "{}") ?? {};
    addLog("sys", `Function call: ${name}(${JSON.stringify(args)})`);

    if (!call_id || !name) return;

    // We treat these as suggestions; apply carefully.
    if (name === "society_propose_bible_update") {
      const parsed = sanitizeUpdate(args);
      if (parsed) applyBibleUpdate(parsed);
      // Send function_call_output acknowledgement so the model can continue if needed.
      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: true }) },
      });
      // Only create a response if this function call was the only output (avoid double-speaking).
      // We can't fully know here, but it's generally safe to skip.
      return;
    }

    if (name === "society_propose_image_scene") {
      // Route through /api/image-scene so images are saved to disk.
      // The model's proposed prompt/styleGuide are ignored in favour of a
      // fresh canon-consistent proposal from the server — this avoids double
      // prompting and keeps the style consistent.
      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: true }) },
      });
      // Fire-and-forget via the shared helper so it also updates state/saves.
      onGenerateImage().catch(() => {});
      return;
    }

    sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: false, error: "unknown_function" }) },
    });
  }

  async function requestOobBibleUpdate(lastTranscript: string) {
    // Don't update the bible until the player has established the core value.
    // Before that, the AI is only asking questions — there's no canon to extract.
    if (!bibleRef.current.canon.coreValues[0]) return;
    if (!lastTranscript?.trim()) return;

    // Use a direct server-side fetch instead of the realtime data-channel
    // "conversation: none" mechanism, which is unreliable on this endpoint.
    const requestSessionId = sessionIdRef.current;
    try {
      const r = await fetch("/api/bible-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bible: bibleRef.current, lastAiTranscript: lastTranscript }),
      });
      if (!r.ok) return;
      const data = await r.json().catch(() => null);
      if (!data) return;
      if (sessionIdRef.current !== requestSessionId) return; // session changed
      const update: BibleUpdate = {
        addCanon: Array.isArray(data.addCanon) ? data.addCanon.map(String) : [],
        addOpenThreads: Array.isArray(data.addOpenThreads) ? data.addOpenThreads.map(String) : [],
        contradictionsFound: Array.isArray(data.contradictionsFound) ? data.contradictionsFound.map(String) : [],
        reconciliationOptions: Array.isArray(data.reconciliationOptions) ? data.reconciliationOptions.map(String) : [],
      };
      applyBibleUpdate(update);
    } catch {
      // Fail silently — bible updates are best-effort
    }
  }

  function applyBibleUpdate(update: BibleUpdate) {
    setBible((prev) => {
      const turn = prev.turnCount + 1;
      let next = bumpTurn(prev);
      next.lastAiUtterance = lastAssistantTranscriptRef.current || prev.lastAiUtterance;
      if (update.addCanon?.length) next = addCanonLines(next, update.addCanon, turn);
      if (update.addOpenThreads?.length) next = addOpenThreads(next, update.addOpenThreads);
      return next;
    });
  }

  // --- UI actions -------------------------------------------------------------

  const onRecap = () => {
    const activeBible = bibleRef.current;
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "recap" },
        output_modalities: ["text"],
        instructions: `Respond only in English. ${recapPrompt(activeBible)}`,
      })
    );
  };

  const onStop = () => {
    if (!connected || stopping) {
      stop();
      return;
    }

    setStopping(true);
    addLog("sys", "Stopping… saving session record.");
    pendingFinalBreakdownRef.current = true;
    onRecap();
  };

  const onTogglePause = () => {
    const local = localStreamRef.current;
    if (!connected || !local) return;
    const next = !paused;
    local.getAudioTracks().forEach((t) => {
      t.enabled = !next && !aiSpeakingRef.current;
    });
    setPaused(next);
    addLog("sys", next ? "Paused input." : "Resumed input.");
  };

  const onUndo = () => {
    setBible((prev) => {
      const next = structuredClone(prev);
      next.changelog.pop();
      return next;
    });
    addLog("sys", "Undo: removed last canon line.");
  };

  const onGenerateImage = async () => {
    // Images are generated via HTTP (/api/image-scene), not the realtime data channel.
    // Requiring dc.open blocked generation whenever the channel was flaky or still opening.
    if (imageBusy) return;
    if (!sessionIdRef.current) {
      addLog("sys", "Image skipped: no session id yet.");
      return;
    }
    setImageBusy(true);
    const requestSessionId = sessionIdRef.current;
    addLog("sys", "Generating image scene…");
    try {
      const r = await fetch("/api/image-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bible: bibleRef.current,
          styleGuide: imageStyleGuide,
          sessionId: requestSessionId,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || (!data?.b64 && !data?.imagePath)) {
        addLog("sys", `Image scene error: ${String(data?.error ?? r.status)}`);
        return;
      }
      if (sessionIdRef.current !== requestSessionId) {
        addLog("sys", "Discarded image for previous session.");
        return;
      }
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
        },
      ]);
      window.dispatchEvent(
        new CustomEvent("society-activity", { detail: { message: `Image: ${data.title ?? "scene"}` } })
      );
    } finally {
      setImageBusy(false);
    }
  };

  // Fire the very first image as soon as the core value is established.
  // imageBusy is in deps so that if the first attempt was skipped (busy/not-ready),
  // the effect re-runs when imageBusy clears and retries automatically.
  useEffect(() => {
    if (!autoImages) return;
    if (!connected) return;
    if (imageBusy) return;
    if (!bible.canon.coreValues[0]) return;
    if (images.length > 0) return;
    onGenerateImage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bible.canon.coreValues[0], connected, imageBusy, autoImages]);

  // Subsequent auto-images every N turns during gameplay.
  useEffect(() => {
    if (!autoImages) return;
    if (!connected) return;
    if (imageBusy) return;
    if (bible.turnCount <= 0) return;
    if (autoEveryTurns <= 0) return;
    if (bible.turnCount % autoEveryTurns !== 0) return;
    if (lastAutoImageTurnRef.current === bible.turnCount) return;

    lastAutoImageTurnRef.current = bible.turnCount;
    onGenerateImage();
  }, [autoImages, autoEveryTurns, bible.turnCount, connected, imageBusy]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("society-image-busy", { detail: { busy: imageBusy } }));
  }, [imageBusy]);

  useEffect(() => {
    const handler = () => {
      if (connected) return;
      // Always reset a stuck/failed connect attempt (e.g. mic prompt ignored left `connecting` true).
      stop();
      void start();
    };
    window.addEventListener("society-start", handler);
    return () => window.removeEventListener("society-start", handler);
  }, [connected]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mode?: string } | undefined;
      if (detail?.mode === "recap") {
        startModeRef.current = "recap";
        if (connected) {
          const captions = imagesRef.current.map((i) => i.caption || i.title || "").filter(Boolean);
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions: `${ENGLISH_ONLY_INSTRUCTION} ${recapNarrationPrompt(bibleRef.current, captions)}`,
              metadata: { topic: "recap_spoken" },
            })
          );
          startModeRef.current = "continue";
        } else if (!connecting) {
          start();
        }
      }
    };
    window.addEventListener("society-recap", handler);
    return () => window.removeEventListener("society-recap", handler);
  }, [connected, connecting]);

  useEffect(() => {
    const handler = () => {
      startModeRef.current = "continue";
      if (connected) {
        sendSessionInstructions();
        const resumeBible2 = bibleRef.current;
        const coreValue2 = resumeBible2.canon.coreValues?.[0] || resumeBible2.lastUserUtterance || "";
        const recentCanon2 = resumeBible2.changelog
          .slice()
          .sort((a: any, b: any) => a.turn - b.turn)
          .slice(-8)
          .map((c: any) => `- ${c.entry}`)
          .join("\n") || "- (none yet)";
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions: `${ENGLISH_ONLY_INSTRUCTION}

You are resuming an existing Society session. Treat every item below as hard canon. Do NOT invent, add, or contradict anything not listed here.

CORE VALUE: ${coreValue2 || "(not yet set)"}

ESTABLISHED CANON:
${recentCanon2}

Welcome the player back in one short sentence. Remind them of the core value in one sentence. Then ask one short open question to continue — 2–3 options. Do not invent new facts. Keep it concise.`,
            metadata: { topic: "resume" },
          })
        );
        startModeRef.current = "new";
      } else if (!connecting) {
        resumeAfterConnectRef.current = true;
        start();
      }
    };
    window.addEventListener("society-resume", handler);
    return () => window.removeEventListener("society-resume", handler);
  }, [connected, connecting]);

  useEffect(() => () => stop(), []);

  return (
    <div className="card">
      <div className="kv vcHeaderRow">
        <div className="kv">
          {!connected ? (
            <button onClick={start} disabled={connecting}>
              {startLabel}
            </button>
          ) : (
            <>
              <button onClick={onTogglePause}>
                {paused ? "Play" : "Pause"}
              </button>
              <button onClick={onStop}>
                Stop
              </button>
            </>
          )}
          <button onClick={onUndo}>
            Undo
          </button>
          <span className={`statusLight ${connected ? "statusLight--on" : "statusLight--off"}`} />
        </div>
        </div>

      <div className="liveTranscript">
        <canvas className="aiWave" ref={waveCanvasRef} width={320} height={80} />
      </div>

      {showSettings ? (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalHeader">
              <strong>Settings</strong>
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
                  Core value{" "}
                  <input
                    className="sessionTitleInput"
                    value={bible.canon.coreValues?.[0] ?? bible.lastUserUtterance ?? ""}
                    readOnly
                  />
                </label>
              ) : null}
          <label className="tag">
            Voice{" "}
            <select
              value={voice}
              disabled={connected || connecting}
              onChange={(e) => setVoice(e.target.value as any)}
                  className="vcFieldSpacing"
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="tag">
            Play{" "}
            <select
              value={playfulness}
              disabled={connected || connecting}
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
                Players{" "}
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={players}
                  onChange={(e) => setPlayers(Number(e.target.value))}
                  className="vcNumberInput"
                />
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
              <span className="tag">Wear headphones to avoid echo.</span>

              <details>
                <summary className="muted">Event log</summary>
                <div className="card vcLogCard">
            {log.length === 0 ? (
              <small className="muted">No events yet.</small>
            ) : (
                    <div className="vcLogList">
                {log.slice().reverse().slice(0, 120).map((l, i) => (
                  <div key={i}>
                    <span className="tag">{l.at}</span>{" "}
                    <span className="tag">{l.dir}</span>{" "}
                          <span className="vcLogText">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
              </details>

              <details>
                <summary className="muted">Summary so far</summary>
                <div className="card vcSummaryCard">
                  <div className="kv vcSummaryActions">
                    <button onClick={onRecap} disabled={!connected && !sessionId}>
                      Update summary
                    </button>
                    {sessionId ? (
                      <button onClick={onDeleteSession}>
                        Delete session
                      </button>
                    ) : null}
      </div>
                  {lastSaveAt ? (
                    <small className="muted">
                      Last saved: {lastSaveAt}{lastSaveTitle ? ` — ${lastSaveTitle}` : ""}
                    </small>
                  ) : null}
                  {summary ? <pre>{summary}</pre> : <small className="muted">No summary yet. Press “Update summary”.</small>}
                </div>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
