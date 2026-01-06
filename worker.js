import fs from "fs";
import path from "path";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("Missing REDIS_URL env var");

const connection = new IORedis(REDIS_URL);

const RENDERS_DIR = path.join(__dirname, "renders");
fs.mkdirSync(RENDERS_DIR, { recursive: true });

// IMPORTANT: you must upload a music file later OR use silent fallback
const MUSIC_PATH = path.join(__dirname, "assets", "music", "kids_loop_01.mp3");

function safeParseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function buildScenes(payload) {
  const durationTarget = Number(payload.durationTarget || 4);

  // target 3–5 minutes by controlling per-card seconds + number of cards
  // We'll aim ~15 seconds per card for calm pacing.
  const perCard = 15;

  const letters = safeParseJson(payload.contentJson || "[]", []);
  const maxCards = Math.max(10, Math.min(18, Math.floor(((durationTarget * 60) - 12) / perCard)));

  const cards = letters.slice(0, maxCards);

  const scenes = [];
  scenes.push({ durationSec: 6, bg: "#A9D6F5", title: "FUN LEARNING TIME!", subtitle: "Let’s Learn Our ABCs" });

  cards.forEach((x, i) => {
    scenes.push({
      durationSec: perCard,
      bg: i % 2 ? "#BEEBC4" : "#F7E6A5",
      title: x.letter,
      subtitle: `${x.letter} is for ${x.word}`
    });
  });

  // Quick review scene (adds structure + time)
  scenes.push({ durationSec: 10, bg: "#D9C2F0", title: "Let’s Review!", subtitle: "Say the sounds with me!" });

  scenes.push({ durationSec: 6, bg: "#A9D6F5", title: "Great Job!", subtitle: "See you next time 👋" });
  return scenes;
}

function svgForScene(scene, t) {
  // gentle bounce
  const bounce = Math.round(Math.sin(t * Math.PI) * 10);
  const yTitle = 36 + bounce * 0.04;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
  <rect width="100%" height="100%" fill="${scene.bg}" />
  <text x="50%" y="${yTitle}%" text-anchor="middle"
    font-family="Arial Rounded MT Bold, Arial, sans-serif"
    font-size="180" font-weight="900" fill="#1f2937">${scene.title}</text>
  <text x="50%" y="60%" text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="64" font-weight="800" fill="#374151">${scene.subtitle || ""}</text>
</svg>`.trim();
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function renderVideo(renderId, payload) {
  const fps = 12;
  const renderDir = path.join(RENDERS_DIR, renderId);
  const framesDir = path.join(renderDir, "frames");
  const pngDir = path.join(renderDir, "png");
  ensureDir(framesDir);
  ensureDir(pngDir);

  const scenes = buildScenes(payload);

  // Write SVG frames
  let idx = 0;
  for (const scene of scenes) {
    const totalFrames = Math.round(scene.durationSec * fps);
    for (let f = 0; f < totalFrames; f++) {
      const t = totalFrames <= 1 ? 0 : f / (totalFrames - 1);
      const svg = svgForScene(scene, t);
      fs.writeFileSync(path.join(framesDir, `frame_${String(idx).padStart(5, "0")}.svg`), svg);
      idx++;
    }
  }

  // Convert SVG -> PNG.
  // Render’s Linux environment supports bash. This avoids local installs.
  execSync(
    `bash -lc 'for f in "${framesDir}"/frame_*.svg; do ffmpeg -y -i "$f" "${pngDir}/$(basename "$f" .svg).png" >/dev/null 2>&1; done'`,
    { stdio: "inherit" }
  );

  const silentMp4 = path.join(renderDir, "silent.mp4");
  const finalMp4 = path.join(renderDir, "final.mp4");

  execSync(
    `ffmpeg -y -framerate ${fps} -i "${pngDir}/frame_%05d.png" -c:v libx264 -pix_fmt yuv420p "${silentMp4}"`,
    { stdio: "inherit" }
  );

  // Add music if file exists, else keep silent
  if (fs.existsSync(MUSIC_PATH)) {
    execSync(
      `ffmpeg -y -i "${silentMp4}" -stream_loop -1 -i "${MUSIC_PATH}" -shortest ` +
      `-filter_complex "[1:a]volume=0.15[a]" -map 0:v -map "[a]" -c:v copy -c:a aac "${finalMp4}"`,
      { stdio: "inherit" }
    );
  } else {
    fs.copyFileSync(silentMp4, finalMp4);
  }
}

new Worker(
  "renders",
  async (job) => {
    const { renderId, ...payload } = job.data;
    renderVideo(renderId, payload);
    return { ok: true };
  },
  { connection }
);

console.log("Worker running...");
