import fs from "fs";
import path from "path";
import OpenAI from "openai";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadEnvLocal();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in environment or .env.local");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = [
    "Create a lush, panoramic 16-bit pixel art welcome scene for the game Society.",
    "It should read as ONE continuous landscape inhabited by people.",
    "Within that single landscape, we see THREE distinct realities/societies overlaying it, each taking roughly one-third of the width:",
    "1) a bright sci‑fi society with neon tech, floating structures, and sleek transit; palette: blues and pinks;",
    "2) a steampunk society with brass machinery, smokestacks, airships, and clockwork; palette: greys, dark blues, blacks;",
    "3) a medieval society with stone towns, markets, and farms; palette: browns and greens.",
    "These three should be radically distinct in organizing principle, architecture, and fashion.",
    "The boundaries between them are soft and hazy; they phase into each other with subtle overlap.",
    "People or structures can straddle two realities to emphasize the blend.",
    "The image should be packed with tiny details and people, like a Where's Waldo scene.",
    "Crisp pixels, subtle dithering, no text, no logos, no watermarks."
  ].join(" ");

  const img = await client.images.generate({
    model: "gpt-image-1",
    prompt,
    n: 1,
    size: "1536x1024",
  });

  const b64 = img.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned");

  const outPath = path.resolve(process.cwd(), "public", "welcome-society.png");
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`Saved ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
