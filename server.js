import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("Missing REDIS_URL env var");

const connection = new IORedis(REDIS_URL);
const renderQueue = new Queue("renders", { connection });

const RENDERS_DIR = path.join(__dirname, "renders");
fs.mkdirSync(RENDERS_DIR, { recursive: true });

// --- Simple Web UI (no Next.js, fastest) ---
app.get("/", (_req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Kids Video Generator</title>
    <style>
      body{font-family:system-ui;margin:24px;max-width:900px}
      textarea,input,select{width:100%;padding:10px;margin-top:6px}
      button{padding:10px 14px;margin-right:10px;margin-top:12px}
      .row{margin-top:14px}
      .status{font-weight:700}
      .err{color:crimson}
    </style>
  </head>
  <body>
    <h1>Kids Video Generator (3–5 min)</h1>

    <div class="row">
      <label>Title</label>
      <input id="title" value="ABCs A–L" />
    </div>

    <div class="row">
      <label>Length (minutes)</label>
      <select id="minutes">
        <option value="3">3</option>
        <option value="4" selected>4</option>
        <option value="5">5</option>
      </select>
    </div>

    <div class="row">
      <label>Content JSON (ABCs)</label>
      <textarea id="content" rows="14">[
  {"letter":"A","word":"Apple"},
  {"letter":"B","word":"Ball"},
  {"letter":"C","word":"Cat"},
  {"letter":"D","word":"Dog"},
  {"letter":"E","word":"Egg"},
  {"letter":"F","word":"Fish"},
  {"letter":"G","word":"Goat"},
  {"letter":"H","word":"Hat"},
  {"letter":"I","word":"Igloo"},
  {"letter":"J","word":"Jam"},
  {"letter":"K","word":"Kite"},
  {"letter":"L","word":"Lion"}
]</textarea>
    </div>

    <div class="row">
      <button onclick="start()">Generate Video</button>
      <button onclick="check()">Check Status</button>
    </div>

    <div class="row status">Status: <span id="status">idle</span></div>
    <div class="row err" id="error"></div>
    <div class="row" id="download"></div>

    <script>
      let renderId = null;

      async function start(){
        document.getElementById("error").textContent = "";
        document.getElementById("download").innerHTML = "";
        document.getElementById("status").textContent = "starting";

        const payload = {
          type: "ABCS",
          title: document.getElementById("title").value,
          durationTarget: Number(document.getElementById("minutes").value),
          contentJson: document.getElementById("content").value
        };

        const res = await fetch("/render", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if(!res.ok){
          document.getElementById("status").textContent = "error";
          document.getElementById("error").textContent = data.error || "Failed";
          return;
        }
        renderId = data.renderId;
        document.getElementById("status").textContent = "rendering";
      }

      async function check(){
        if(!renderId) return;
        const res = await fetch("/render/" + renderId);
        const data = await res.json();

        document.getElementById("status").textContent = data.status;

        if(data.status === "done"){
          document.getElementById("download").innerHTML =
            '<a href="' + data.downloadUrl + '"><b>Download MP4</b></a>';
        }
        if(data.status === "error"){
          document.getElementById("error").textContent = data.error || "Render failed";
        }
      }
    </script>
  </body>
</html>
  `);
});

// --- API: start render ---
app.post("/render", async (req, res) => {
  try {
    const renderId = crypto.randomUUID();
    await renderQueue.add("render", { renderId, ...req.body }, { jobId: renderId });
    res.json({ renderId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- API: check status ---
app.get("/render/:id", async (req, res) => {
  const job = await renderQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ status: "not_found" });

  const state = await job.getState();

  if (state === "completed") {
    return res.json({ status: "done", downloadUrl: `/download/${req.params.id}` });
  }
  if (state === "failed") {
    return res.json({ status: "error", error: job.failedReason || "Failed" });
  }
  return res.json({ status: state });
});

// --- download MP4 ---
app.get("/download/:id", (req, res) => {
  const filePath = path.join(RENDERS_DIR, req.params.id, "final.mp4");
  if (!fs.existsSync(filePath)) return res.status(404).send("Not ready");
  res.download(filePath);
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Web server on", port));
