"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bumpTurn, addCanonLines, addOpenThreads } from "@/lib/societyBible";
import { useSociety } from "./SocietyContext";
import { saveGame, listGames, deleteGame, getGame } from "@/lib/gameHistory";
import {
  systemInstructions,
  bibleSummaryForModel,
  oobUpdatePrompt,
  recapPrompt,
  finalBreakdownPrompt,
  imageSceneProposalPrompt,
  imagePromptFromBible,
  recapNarrationPrompt,
  Playfulness,
} from "@/lib/prompts";
import { safeJsonParse, sanitizeUpdate } from "@/lib/guardrails";
import { mkSessionUpdate, mkResponseCreate } from "@/lib/realtimeEvents";
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
  const cleaned = coreChoice.replace(/\s+/g, " ").trim();
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

function pickSessionTitle(bible: typeof bibleRef.current, parsedCore?: string, parsedTitle?: string) {
  const core0 = String(parsedCore ?? bible?.canon?.coreValues?.[0] ?? "").trim();
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

function getCoreChoice(bible: typeof bibleRef.current) {
  const explicit = String(bible?.canon?.coreValues?.[0] ?? "").trim();
  const lastUser = String(bible?.lastUserUtterance ?? "").trim();
  const genericPattern = /started a session|session started|participants have started|society places|central value|shapes all aspects of life/i;
  if (lastUser && !genericPattern.test(lastUser)) return lastUser;
  if (explicit) return explicit;
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
        description: "Propose a vivid image scene prompt that illustrates the society consistently with canon.",
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

  const sendSessionInstructions = () => {
    const sessionInstructions = `${systemInstructions(playfulness)}\n\n${bibleSummaryForModel(bibleRef.current)}`;
    sendEvent(
      mkSessionUpdate({
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
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
    setConnecting(true);
    setLiveTranscript("");
    setPaused(false);
    window.dispatchEvent(new Event("society-started"));
    try {
      if (startModeRef.current === "continue" && !sessionIdRef.current) {
        setConnecting(false);
        window.setTimeout(() => start(), 120);
        return;
      }
      // If resuming a loaded session, wait until sessionId is set.
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
      remoteAudioRef.current = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
      };

      // Local mic
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = ms;      pc.addTrack(ms.getAudioTracks()[0], ms);

      // Data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        addLog("sys", "Data channel open.");
        setConnected(true);
        setConnecting(false);

        // Session guardrails + tool config.
        // Note: voice must match the server session voice before the first audio response.
        sendSessionInstructions();

        const effectiveMode =
          startModeRef.current === "new" && bibleRef.current.turnCount > 0 ? "continue" : startModeRef.current;

        if (effectiveMode === "recap") {
          const captions = imagesRef.current.map((i) => i.caption || i.title || "").filter(Boolean);
          if (imagesRef.current.length > 0) {
            window.dispatchEvent(
              new CustomEvent("society-recap-slideshow", { detail: { intervalMs: 4200 } })
            );
          }
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions: recapNarrationPrompt(bibleRef.current, captions),
              metadata: { topic: "recap_spoken" },
            })
          );
          startModeRef.current = "continue";
        } else if (effectiveMode === "continue") {
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions:
                "Warmly welcome the player back and continue seamlessly from the existing canon summary above. In one short sentence, remind them of the core value of this society. Then prompt the next addition with one short, open question and 2–3 options. Do not invent new facts. Keep it concise.",
              metadata: { topic: "resume" },
            })
          );
          startModeRef.current = "new";
        } else {
          // Send a proactive greeting so the AI immediately invites the user to play.
          sendEvent(
            mkResponseCreate({
              output_modalities: ["audio"],
              instructions:
                "Greet warmly in a relaxed tone, then invite the first move. Explain they should start by saying what the most important thing in this society is, and that everything else follows from that starting point. Mention it can be anything. Optionally offer 2–3 example answers (e.g., empathy, honor, efficiency). Keep it short and speakable.",
              metadata: { topic: "greeting" },
            })
          );
        }
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

      if (!sdpResp.ok) {
        const err = await sdpResp.text();
        throw new Error(err);
      }

      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      addLog("sys", "WebRTC connected; waiting for session.created...");
      setConnecting(false);
    } catch (err: any) {      setConnecting(false);
      addLog("sys", `Start error: ${String(err?.message ?? err)}`);
      stop();
    }
  }

  function stop() {
    setConnected(false);
    setConnecting(false);
    setStopping(false);
    setPaused(false);
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
    const coreChoice = getCoreChoice(bibleToSave);
    if (!coreChoice) return;
    const title = pickSessionTitle(bibleToSave);
    try {
      await saveGame({
        id,
        createdAt: Date.now(),
        title,
        finalRecordText: finalRecord ?? "",
        summary: summaryRef.current,
        bible: bibleToSave,
        images: imagesToSave,
      });
      setLastSaveAt(new Date().toLocaleString());
      setLastSaveTitle(title);
    } catch {
      // ignore autosave failures
    }
  };

  const onDeleteSession = async () => {
    if (!sessionIdRef.current) return;
    const id = sessionIdRef.current;
    try {
      await deleteGame(id);
      setHistory(await listGames());
    } catch {
      // ignore delete failures
    }
    setSessionId("");
    setSummary("");
    setFinalRecord("");
    setImages([]);
    setBible((prev) => ({ ...prev, turnCount: 0, lastAiUtterance: "", changelog: [], openThreads: [] }));
  };

  const onRenameSession = async () => {
    const id = sessionIdRef.current;
    const nextTitle = editTitle.trim();
    if (!id || !nextTitle) return;
    try {
      const existing = await getGame(id);
      if (existing) {
        await saveGame({ ...existing, title: nextTitle });
      } else {
        await saveGame({
          id,
          createdAt: Date.now(),
          title: nextTitle,
          finalRecordText: finalRecord ?? "",
          summary: summaryRef.current,
          bible: bibleRef.current,
          images: imagesRef.current,
        });
      }
      setHistory(await listGames());
      setLastSaveAt(new Date().toLocaleString());
      setLastSaveTitle(nextTitle);
      setEditTitle("");
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

    if (evt.type === "error") {    }

    // Transcript deltas (audio transcript)
    if (evt.type === "response.output_audio_transcript.delta") {
      const delta = evt?.delta ?? "";
      setLiveTranscript((t) => t + delta);
      return;
    }

    // User transcript deltas
    if (evt.type === "input_audio_transcript.delta") {
      const delta = evt?.delta ?? "";
      lastUserTranscriptRef.current += delta;
      return;
    }

    if (evt.type === "input_audio_transcript.done") {
      const transcript = String(evt?.transcript ?? lastUserTranscriptRef.current ?? "").trim();
      lastUserTranscriptRef.current = "";
      const genericPattern = /started a session|session started|participants have started|society places|society values|central value|core value|central core|shapes all aspects|all other aspects|emerge|game is called society|society is called/i;
      const tooSoon = Date.now() - lastAssistantAtRef.current < 5000;
      if (
        transcript &&
        !genericPattern.test(transcript) &&
        !isLikelyEcho(transcript, lastAssistantTranscriptRef.current) &&
        !tooSoon
      ) {
        setBible((b) => ({ ...b, lastUserUtterance: transcript }));
      }
      return;
    }

    if (evt.type === "response.output_audio_transcript.done") {
      const transcript = evt?.transcript ?? liveTranscript;
      lastAssistantTranscriptRef.current = transcript;
      lastAssistantAtRef.current = Date.now();
      const pendingUser = String(lastUserTranscriptRef.current ?? "").trim();
      if (pendingUser) {
        const genericPattern = /started a session|session started|participants have started|society places|society values|central value|core value|central core|shapes all aspects|all other aspects|emerge|game is called society|society is called/i;
        const tooSoon = Date.now() - lastAssistantAtRef.current < 5000;
        if (!genericPattern.test(pendingUser) && !isLikelyEcho(pendingUser, transcript) && !tooSoon) {
          setBible((b) => ({ ...b, lastUserUtterance: pendingUser }));
        }
        lastUserTranscriptRef.current = "";
      }
      setBible((b) => ({ ...b, lastAiUtterance: transcript }));
      setLiveTranscript("");

      // After the model speaks, we do an out-of-band JSON update to propose canon changes.
      // This avoids tool-calling interrupting speech.
      await requestOobBibleUpdate(transcript);
      return;
    }

    // Final response object (can also carry function calls)
    if (evt.type === "response.done") {
      // If this was our recap or OOB update, it'll have metadata.topic.
      const topic = evt?.response?.metadata?.topic;

      // Handle function calling outputs if present.
      const output = evt?.response?.output ?? [];
      for (const item of output) {
        if (item?.type === "function_call") {
          await handleFunctionCall(item);
        }
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
              instructions: finalBreakdownPrompt(bible),
            })
          );
        }
      }

      if (topic === "bible_update") {
        const text = extractTextFromResponse(evt);
        const parsed = sanitizeUpdate(safeJsonParse<Partial<BibleUpdate>>(text));
        if (parsed) {
          applyBibleUpdate(parsed);
        } else {
          addLog("sys", `Could not parse bible_update JSON. Raw: ${text.slice(0, 500)}`);
        }
      }

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
          await saveGame({
            id,
            createdAt: Date.now(),
            title,
            finalRecordText: pretty,
            summary: summaryRef.current,
            bible: bibleToSave,
            images: imagesToSave,
          });
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

      if (topic === "image_scene") {
        const text = extractTextFromResponse(evt);
        const parsed = safeJsonParse<any>(text);
        const title = String(parsed?.title ?? `Turn ${bible.turnCount}: scene`);
        const caption = String(parsed?.caption ?? "");
        const seedFacts = Array.isArray(parsed?.seedFacts) ? parsed.seedFacts.map(String).slice(0, 8) : [];
        const styleGuide = String(parsed?.styleGuide ?? "");
        const prompt = String(parsed?.prompt ?? "");
        const negative = String(
          parsed?.negativePrompt ?? "text, logos, watermark, explicit nudity, explicit sexual content, gore, graphic violence"
        );

        if (!prompt) {
          addLog("sys", `Image scene parse failed: ${text.slice(0, 240)}`);
          setImageBusy(false);
          return;
        }

        if (!imageStyleGuide && styleGuide) setImageStyleGuide(styleGuide);

        const fullPrompt = `${styleGuide ? `STYLE GUIDE (keep consistent): ${styleGuide}\n\n` : ""}${
          seedFacts.length ? `CANON SEEDS (must reflect):\n- ${seedFacts.join("\n- ")}\n\n` : ""
        }${prompt}\n\nAvoid: ${negative}`;
        try {
          const requestSessionId = sessionIdRef.current;
          addLog("sys", "Generating image…");
          const r = await fetch("/api/image-generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: fullPrompt,
              size: IMAGE_SIZE,
            }),
          });
          if (!r.ok) {
            addLog("sys", `Image error: ${await r.text()}`);
            setImageBusy(false);
            return;
          }
          const data = (await r.json()) as { b64: string };
          if (sessionIdRef.current !== requestSessionId) {
            addLog("sys", "Discarded image for previous session.");
            return;
          }
          setImages((prev) => [
            ...prev,
            { b64: data.b64, title, caption, seedFacts, promptUsed: fullPrompt.slice(0, 4000), at: new Date().toLocaleString() },
          ]);        } finally {
          setImageBusy(false);
        }
      }

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
      // Generate an image immediately from the proposed prompt.
      const title = String(args?.title ?? `Turn ${bible.turnCount}: scene`);
      const caption = String(args?.caption ?? "");
      const seedFacts = Array.isArray(args?.seedFacts) ? args.seedFacts.map(String).slice(0, 8) : [];
      const styleGuide = String(args?.styleGuide ?? "");
      const prompt = String(args?.prompt ?? "");
      const negative = String(
        args?.negativePrompt ?? "text, logos, watermark, explicit nudity, explicit sexual content, gore, graphic violence"
      );

      if (!imageStyleGuide && styleGuide) setImageStyleGuide(styleGuide);

      const fullPrompt = `${styleGuide ? `STYLE GUIDE (keep consistent): ${styleGuide}\n\n` : ""}${
        seedFacts.length ? `CANON SEEDS (must reflect):\n- ${seedFacts.join("\n- ")}\n\n` : ""
      }${prompt}\n\nAvoid: ${negative}`;

      if (prompt) {
        try {
          const requestSessionId = sessionIdRef.current;
          setImageBusy(true);
          addLog("sys", "Generating image…");
          const r = await fetch("/api/image-generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: fullPrompt,
              size: IMAGE_SIZE,
            }),
          });
          if (r.ok) {
            const data = (await r.json()) as { b64: string };
            if (sessionIdRef.current !== requestSessionId) {
              addLog("sys", "Discarded image for previous session.");
              return;
            }
            setImages((prev) => [
              ...prev,
              { b64: data.b64, title, caption, seedFacts, promptUsed: fullPrompt.slice(0, 4000), at: new Date().toLocaleString() },
            ]);
          window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: `Image: ${title}` } }));
            window.dispatchEvent(new CustomEvent("society-activity", { detail: { message: `Image: ${title}` } }));
          } else {
            addLog("sys", `Image error: ${await r.text()}`);
          }
        } finally {
          setImageBusy(false);
        }
      }

      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: true }) },
      });
      return;
    }

    sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: false, error: "unknown_function" }) },
    });
  }

  async function requestOobBibleUpdate(lastTranscript: string) {
    const prompt = oobUpdatePrompt(bible, lastTranscript);
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "bible_update" },
        output_modalities: ["text"],
        instructions: prompt,
      })
    );
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
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "recap" },
        output_modalities: ["text"],
        instructions: recapPrompt(bible),
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
      t.enabled = !next;
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
    if (!connected || imageBusy) return;
    setImageBusy(true);
    // Ask the model (text-only, out-of-band) for a canon-consistent image prompt, then generate.
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "image_scene" },
        output_modalities: ["text"],
        instructions: imageSceneProposalPrompt(bible, imageStyleGuide),
      })
    );
  };

  useEffect(() => {
    if (!autoImages) return;
    if (!connected) return;
    if (imageBusy) return;
    if (bible.turnCount <= 0) return;
    if (bible.changelog.length < 3) return;
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
      if (connected || connecting) return;
      start();
    };
    window.addEventListener("society-start", handler);
    return () => window.removeEventListener("society-start", handler);
  }, [connected, connecting]);

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
              instructions: recapNarrationPrompt(bibleRef.current, captions),
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
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions:
              "Warmly welcome the player back and continue seamlessly from the existing canon summary above. In one short sentence, remind them of the core value of this society. Then prompt the next addition with one short, open question and 2–3 options. Do not invent new facts. Keep it concise.",
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
        {liveTranscript ? <pre>{liveTranscript}</pre> : <small className="muted">The AI voice appears here as it speaks.</small>}
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
                  {sessionId ? (
                    <div className="kv vcSummaryActions">
                      <input
                        className="sessionTitleInput"
                        placeholder="Rename session..."
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                      <button onClick={onRenameSession} disabled={!editTitle.trim()}>
                        Save title
                      </button>
                    </div>
                  ) : null}
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
