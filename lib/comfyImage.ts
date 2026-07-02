/**
 * Local ComfyUI image generation client. Talks to a ComfyUI server (default
 * http://127.0.0.1:8188) running the SDXL base checkpoint + the nerijs
 * pixel-art-xl LoRA, tuned to match the existing "64-bit retro pixel art
 * (late PS1/N64-era)" aesthetic used by the OpenAI image path.
 */

const COMFY_URL = (process.env.COMFY_URL?.trim() || "http://127.0.0.1:8188").replace(/\/+$/, "");
const CHECKPOINT = process.env.COMFY_CHECKPOINT?.trim() || "sd_xl_base_1.0.safetensors";
const LORA = process.env.COMFY_LORA?.trim() || "pixel-art-xl.safetensors";
const VAE = process.env.COMFY_VAE?.trim() || "sdxl_vae_fp16_fix.safetensors";
// SDXL on Apple-Silicon MPS is slow (~4-5s per step), so 30 steps + model load
// can exceed 3 minutes. 20 steps is plenty for the pixel-art LoRA and shaves
// ~45s. The poll timeout must comfortably exceed a full generation or the API
// gives up right before ComfyUI finishes (which is exactly what happened at
// the old 180s cap vs a 182s generation).
const STEPS = Number(process.env.COMFY_STEPS?.trim()) || 20;
const POLL_TIMEOUT_MS = Number(process.env.COMFY_TIMEOUT_MS?.trim()) || 360_000;

// The nerijs pixel-art-xl LoRA was trained with this trigger phrase — omitting
// it produces a generic SDXL illustration instead of crisp retro pixel art.
const LORA_TRIGGER = "pixel art";

function buildWorkflow(opts: {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
}) {
  const { prompt, negativePrompt, width, height, seed } = opts;
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: CHECKPOINT },
    },
    "2": {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: LORA,
        strength_model: 0.9,
        strength_clip: 0.9,
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: VAE },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 1], text: `${LORA_TRIGGER}, ${prompt}` },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 1], text: negativePrompt },
    },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["2", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed,
        steps: STEPS,
        cfg: 7,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["7", 0], vae: ["3", 0] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "society_canyon" },
    },
  };
}

type ComfyHistoryEntry = {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
};

async function pollHistory(promptId: string, timeoutMs: number): Promise<ComfyHistoryEntry> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${COMFY_URL}/history/${promptId}`);
    if (res.ok) {
      const data = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = data[promptId];
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) return entry;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("ComfyUI generation timed out");
}

/**
 * Generate an image via local ComfyUI. Throws on any failure — callers should
 * catch and fall back or surface the error, same as the OpenAI path.
 */
export async function generateImageViaComfy(opts: {
  prompt: string;
  negativePrompt: string;
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const width = opts.width ?? 1536;
  const height = opts.height ?? 1024;
  const seed = Math.floor(Math.random() * 2 ** 32);

  const workflow = buildWorkflow({ prompt: opts.prompt, negativePrompt: opts.negativePrompt, width, height, seed });
  const clientId = crypto.randomUUID();

  const queueRes = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!queueRes.ok) {
    const text = await queueRes.text().catch(() => "");
    throw new Error(`ComfyUI /prompt failed (${queueRes.status}): ${text.slice(0, 500)}`);
  }
  const queued = (await queueRes.json()) as { prompt_id: string };
  if (!queued.prompt_id) throw new Error("ComfyUI did not return a prompt_id");

  const entry = await pollHistory(queued.prompt_id, POLL_TIMEOUT_MS);
  const saveNode = entry.outputs?.["9"];
  const image = saveNode?.images?.[0];
  if (!image) throw new Error("ComfyUI produced no image output");

  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const imgRes = await fetch(`${COMFY_URL}/view?${params.toString()}`);
  if (!imgRes.ok) throw new Error(`ComfyUI /view failed (${imgRes.status})`);
  return Buffer.from(await imgRes.arrayBuffer());
}

export function comfyEnabled(): boolean {
  return (process.env.IMAGE_PROVIDER?.trim().toLowerCase() || "openai") === "comfyui";
}
