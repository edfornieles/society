"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bumpTurn, addCanonLines, addOpenThreads } from "@/lib/societyBible";
import { useSociety } from "./SocietyContext";
import { saveGame, listGames } from "@/lib/gameHistory";
import {
  systemInstructions,
  bibleSummaryForModel,
  oobUpdatePrompt,
  recapPrompt,
  finalBreakdownPrompt,
  imageSceneProposalPrompt,
  imagePromptFromBible,
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

const DEFAULT_32BIT_STYLE_GUIDE =
  "32-bit retro pixel art (SNES/PS1-era). Crisp pixels (no anti-aliasing), limited palette, subtle dithering, strong silhouettes, readable shapes. Cinematic framing translated into pixel art. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

export function VoiceConsoleV2() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [voice, setVoice] = useState<(typeof VOICES)[number]>("marin");
  const [playfulness, setPlayfulness] = useState<Playfulness>(2);

  const { bible, setBible, images, setImages, setSummary, setFinalRecord, setHistory } = useSociety();
  const [log, setLog] = useState<LogLine[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [imageBusy, setImageBusy] = useState(false);
  const [autoImages, setAutoImages] = useState(true);
  const [autoEveryTurns, setAutoEveryTurns] = useState(1);
  const [imageStyleGuide, setImageStyleGuide] = useState<string>(DEFAULT_32BIT_STYLE_GUIDE);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const lastAssistantTranscriptRef = useRef<string>("");
  const lastAutoImageTurnRef = useRef<number>(0);
  const bibleRef = useRef(bible);
  const imagesRef = useRef(images);

  useEffect(() => {
    bibleRef.current = bible;
  }, [bible]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

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

  async function start() {
    setConnecting(true);
    setLiveTranscript("");
    try {
      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H3",
          location: "VoiceConsoleV2:start",
          message: "Requesting getUserMedia",
          data: { constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

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
      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H3",
          location: "VoiceConsoleV2:start",
          message: "getUserMedia success",
          data: { tracks: ms.getAudioTracks().length },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      pc.addTrack(ms.getAudioTracks()[0], ms);

      // Data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        addLog("sys", "Data channel open.");
        setConnected(true);
        setConnecting(false);

        const sessionInstructions = `${systemInstructions(playfulness)}\n\n${bibleSummaryForModel(bible)}`;

        // #region agent log
        fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "debug-session",
            runId: "pre-rules",
            hypothesisId: "H1",
            location: "VoiceConsoleV2:start",
            message: "Session instructions prepared",
            data: {
              length: sessionInstructions.length,
              hasRulesDigest: sessionInstructions.includes("Rules quick reference"),
              playfulness,
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion

        // Session guardrails + tool config.
        // Note: voice must match the server session voice before the first audio response.
        sendEvent(
          mkSessionUpdate({
            type: "realtime",
            model: "gpt-realtime",
            output_modalities: ["audio"],
            instructions: sessionInstructions,
            tools,
            tool_choice: "auto",
            // Keep default VAD (semantic_vad); you can disable auto responses later if you want more control.
          })
        );

        // Send a proactive greeting so the AI immediately invites the user to play.
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions:
              "Greet warmly, then invite the first move. Say: 'You ready to play Society? Why don’t you start: what’s the most important thing in this society?' Optionally offer 2–3 example answers (e.g., empathy, honor, efficiency). Keep it short and speakable.",
            metadata: { topic: "greeting" },
          })
        );
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
    } catch (err: any) {
      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H3",
          location: "VoiceConsoleV2:start",
          message: "Start error",
          data: { error: String(err?.message ?? err) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      setConnecting(false);
      addLog("sys", `Start error: ${String(err?.message ?? err)}`);
      stop();
    }
  }

  function stop() {
    setConnected(false);
    setConnecting(false);
    setStopping(false);
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
    addLog("sys", "Stopped.");
  }

  // --- Server event handling --------------------------------------------------

  const handleServerEvent = async (raw: string) => {
    let evt: any = null;
    try { evt = JSON.parse(raw); } catch { return; }

    // Keep the log readable
    if (evt?.type) addLog("in", `${evt.type}`);

    if (evt.type === "error") {
      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H4",
          location: "VoiceConsoleV2:handleServerEvent",
          message: "Server error event",
          data: { eventType: evt.type, error: evt?.error },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    }

    // Transcript deltas (audio transcript)
    if (evt.type === "response.output_audio_transcript.delta") {
      const delta = evt?.delta ?? "";
      setLiveTranscript((t) => t + delta);
      return;
    }

    if (evt.type === "response.output_audio_transcript.done") {
      const transcript = evt?.transcript ?? liveTranscript;
      lastAssistantTranscriptRef.current = transcript;
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
          addLog("sys", "Generated summary so far.");
        } else {
          setSummary(text);
          addLog("sys", `Summary (raw): ${text.slice(0, 240)}`);
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

        // #region agent log
        fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "debug-session",
            runId: "pre-rules",
            hypothesisId: "H14",
            location: "VoiceConsoleV2:handleServerEvent",
            message: "Final breakdown extraction",
            data: {
              extractedLen: text.length,
              outputTypes: (evt?.response?.output ?? []).map((o: any) => o?.type),
              firstOutputContentTypes: (evt?.response?.output?.[0]?.content ?? []).map((c: any) => c?.type),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion

        // #region agent log
        fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "debug-session",
            runId: "pre-rules",
            hypothesisId: "H6",
            location: "VoiceConsoleV2:handleServerEvent",
            message: "Final breakdown received",
            data: { parsed: Boolean(parsed), chars: String(pretty ?? "").length },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion

        // Persist to history (IndexedDB) so the user can revisit later.
        try {
          const bibleToSave = bibleRef.current;
          const imagesToSave = imagesRef.current;
          const id =
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? (crypto.randomUUID() as string)
              : `game_${Date.now()}_${Math.random().toString(16).slice(2)}`;
          // Name sessions after the "most important thing" (usually the top core value).
          const core0 = String(parsed?.core_values?.[0] ?? "").trim();
          const title =
            core0 ||
            String(parsed?.title ?? "").trim() ||
            (bibleToSave.changelog?.[0]?.entry ? String(bibleToSave.changelog[0].entry).slice(0, 80) : "") ||
            `Society ${new Date().toLocaleString()}`;
          await saveGame({
            id,
            createdAt: Date.now(),
            title,
            finalRecordText: pretty,
            bible: bibleToSave,
            images: imagesToSave,
          });
          setHistory(await listGames());

          // #region agent log
          fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "debug-session",
              runId: "pre-rules",
              hypothesisId: "H11",
              location: "VoiceConsoleV2:handleServerEvent",
              message: "Saved game to history",
              data: { id, title, images: imagesToSave.length, turn: bibleToSave.turnCount },
              timestamp: Date.now(),
            }),
          }).catch(() => {});
          // #endregion
        } catch {
          // ignore persistence errors (private browsing, storage quota, etc.)
        }

        stop();
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

        // #region agent log
        fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "debug-session",
            runId: "pre-rules",
            hypothesisId: "H7",
            location: "VoiceConsoleV2:handleServerEvent",
            message: "Image scene received",
            data: {
              title,
              promptChars: prompt.length,
              negativeChars: negative.length,
              seedFacts: seedFacts.length,
              hasStyleGuide: Boolean(styleGuide),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion

        try {
          addLog("sys", "Generating image…");
          const r = await fetch("/api/image-generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: fullPrompt,
              size: "1024x1024",
            }),
          });
          if (!r.ok) {
            addLog("sys", `Image error: ${await r.text()}`);
            setImageBusy(false);
            return;
          }
          const data = (await r.json()) as { b64: string };
          setImages((prev) => [
            ...prev,
            { b64: data.b64, title, caption, seedFacts, promptUsed: fullPrompt.slice(0, 4000), at: new Date().toLocaleString() },
          ]);

          // #region agent log
          fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "debug-session",
              runId: "pre-rules",
              hypothesisId: "H7",
              location: "VoiceConsoleV2:handleServerEvent",
              message: "Image generated",
              data: { title, b64Len: data.b64?.length ?? 0 },
              timestamp: Date.now(),
            }),
          }).catch(() => {});
          // #endregion
        } finally {
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
          setImageBusy(true);
          addLog("sys", "Generating image…");
          const r = await fetch("/api/image-generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: fullPrompt,
              size: "1024x1024",
            }),
          });
          if (r.ok) {
            const data = (await r.json()) as { b64: string };
            setImages((prev) => [
              ...prev,
              { b64: data.b64, title, caption, seedFacts, promptUsed: fullPrompt.slice(0, 4000), at: new Date().toLocaleString() },
            ]);
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

      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H5",
          location: "VoiceConsoleV2:applyBibleUpdate",
          message: "Bible updated",
          data: {
            addCanonCount: update.addCanon?.length ?? 0,
            addThreadsCount: update.addOpenThreads?.length ?? 0,
            turnCount: next.turnCount,
            changelogLen: next.changelog.length,
            openThreadsLen: next.openThreads.length,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

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

    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "pre-rules",
        hypothesisId: "H6",
        location: "VoiceConsoleV2:onStop",
        message: "Requesting final breakdown",
        data: { turn: bible.turnCount, changelogLen: bible.changelog.length, openThreadsLen: bible.openThreads.length },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "final_breakdown" },
        output_modalities: ["text"],
        instructions: finalBreakdownPrompt(bible),
      })
    );
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

    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "pre-rules",
        hypothesisId: "H7",
        location: "VoiceConsoleV2:onGenerateImage",
        message: "Requesting image scene proposal",
        data: { turn: bible.turnCount, changelogLen: bible.changelog.length },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

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

    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "pre-rules",
        hypothesisId: "H8",
        location: "VoiceConsoleV2:useEffect(autoImages)",
        message: "Auto image trigger",
        data: { turnCount: bible.turnCount, every: autoEveryTurns },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    onGenerateImage();
  }, [autoImages, autoEveryTurns, bible.turnCount, connected, imageBusy]);

  useEffect(() => () => stop(), []);

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <div className="kv">
          <strong>Realtime voice</strong>
          <span className="tag">{connected ? "connected" : connecting ? "connecting…" : "offline"}</span>
        </div>

        <div className="kv">
          <label className="tag">
            Voice{" "}
            <select
              value={voice}
              disabled={connected || connecting}
              onChange={(e) => setVoice(e.target.value as any)}
              style={{ marginLeft: 6 }}
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
              style={{ marginLeft: 6 }}
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>

          {!connected ? (
            <button onClick={start} disabled={connecting}>
              Start
            </button>
          ) : (
            <button onClick={onStop}>{stopping ? "Stopping…" : "Stop"}</button>
          )}
        </div>
      </div>

      <hr />

      <div className="kv">
        <button onClick={onRecap} disabled={!connected}>
          Generate summary
        </button>
        <button onClick={onUndo}>
          Undo last canon line
        </button>
        <button onClick={onGenerateImage} disabled={!connected || imageBusy}>
          {imageBusy ? "Generating…" : "Generate image"}
        </button>
        <label className="tag">
          Auto images{" "}
          <input
            type="checkbox"
            checked={autoImages}
            onChange={(e) => setAutoImages(e.target.checked)}
            style={{ marginLeft: 6 }}
          />
        </label>
        <label className="tag">
          Every{" "}
          <select
            value={autoEveryTurns}
            onChange={(e) => setAutoEveryTurns(Number(e.target.value))}
            style={{ marginLeft: 6 }}
          >
            <option value={1}>1 turn</option>
            <option value={2}>2 turns</option>
            <option value={3}>3 turns</option>
            <option value={4}>4 turns</option>
          </select>
        </label>
        <span className="tag">Tip: wear headphones to avoid echo.</span>
      </div>

      <hr />

      <div style={{ display: "grid", gap: 10 }}>
        <section>
          <strong>Live transcript (assistant)</strong>
          <div className="card" style={{ borderRadius: 10 }}>
            {liveTranscript ? <pre>{liveTranscript}</pre> : <small className="muted">Waiting…</small>}
          </div>
        </section>

        <section>
          <strong>Event log</strong>
          <div className="card" style={{ borderRadius: 10, maxHeight: 240, overflow: "auto" }}>
            {log.length === 0 ? (
              <small className="muted">No events yet.</small>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {log.slice().reverse().slice(0, 120).map((l, i) => (
                  <div key={i}>
                    <span className="tag">{l.at}</span>{" "}
                    <span className="tag">{l.dir}</span>{" "}
                    <span style={{ fontSize: 12 }}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
