import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadWorkshopTreeIndex, buildWorkshopTreePlan } from "../engine/scripts/workshop-tree-index.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = path.join(ROOT, ".env");
const PORT = 4177;
const HOST = "127.0.0.1";

const allowed = [
  "WORKSHOP_SOURCE_DIR", "WORKSHOP_RUNTIME_DIR", "WORKSHOP_TREE_DIR",
  "PDF_OUTPUT_DIR", "PDF_WORK_DIR", "PDF_TITLE", "PDF_FILENAME",
  "PDF_CONCURRENCY", "PDF_SAMPLE_SIZE", "PDF_MERGE_ONLY",
  "PDF_ALLOW_PARTIAL", "PDF_FORCE", "PDF_SHM_SIZE",
  "PDF_STATE_CHECKPOINT_INTERVAL", "PDF_PROGRESS_INTERVAL",
  "PDF_HEARTBEAT_SECONDS", "PDF_GPU_MODE", "PDF_BROWSER_CDP_URL", "PUID", "PGID"
];

let child = null;
let running = false;
let exitCode = null;
let logs = [];
let startedAt = null;

function readEnv() {
  const result = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function addLog(text) {
  logs.push({ time: new Date().toLocaleTimeString(), text: String(text) });
  if (logs.length > 1500) logs = logs.slice(-1200);
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1000000) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function saveEnv(values) {
  const current = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  const updates = new Map(Object.entries(values));
  const output = [];
  const written = new Set();

  for (const line of current) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && updates.has(match[1])) {
      output.push(`${match[1]}=${updates.get(match[1])}`);
      written.add(match[1]);
    } else {
      output.push(line);
    }
  }
  for (const [key, value] of updates) {
    if (!written.has(key)) output.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, output.join("\n").replace(/\n+$/, "") + "\n");
}

function status() {
  return { running, exitCode, startedAt, logs, config: readEnv() };
}


let publisherScannerPromise = null;

async function getPublisherScanner() {
  if (publisherScannerPromise) return publisherScannerPromise;

  publisherScannerPromise = (async () => {
    const temporaryData = path.join("/tmp", `workshop-pdf-control-panel-${process.pid}`);
    const previousData = process.env.WORKSHOP_DATA_DIR;
    const previousRuntime = process.env.WORKSHOP_RUNTIME_DIR;

    process.env.WORKSHOP_DATA_DIR = temporaryData;
    process.env.WORKSHOP_RUNTIME_DIR = path.join(temporaryData, "runtime");

    try {
      const publisher = await import("../engine/server.js");
      await fs.promises.rm(temporaryData, { recursive: true, force: true });
      return publisher;
    } finally {
      if (previousData === undefined) delete process.env.WORKSHOP_DATA_DIR;
      else process.env.WORKSHOP_DATA_DIR = previousData;

      if (previousRuntime === undefined) delete process.env.WORKSHOP_RUNTIME_DIR;
      else process.env.WORKSHOP_RUNTIME_DIR = previousRuntime;
    }
  })();

  try {
    return await publisherScannerPromise;
  } catch (error) {
    publisherScannerPromise = null;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, status());
  }


  if (req.method === "GET" && url.pathname === "/api/selection") {
    try {
      const config = readEnv();
      if (!config.PDF_WORK_DIR) throw new Error("PDF_WORK_DIR is not configured.");
      const file = path.join(config.PDF_WORK_DIR, "topic-selection.json");
      let selection = { enabled: false, selected: [] };
      if (fs.existsSync(file)) {
        selection = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      return send(res, 200, selection);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/selection") {
    try {
      if (running) return send(res, 409, { error: "Stop the publisher before changing the selection." });
      const body = await readBody(req);
      if (!Array.isArray(body.selected)) throw new Error("Selection must contain a selected array.");
      const selected = [];
      const seen = new Set();
      for (const item of body.selected) {
        const rootId = String(item?.rootId || "").trim();
        const id = String(item?.id || "").trim();
        if (!/^X\d+$/.test(rootId) || !/^X\d+$/.test(id)) {
          throw new Error("Each selection entry must have a valid manual ID and topic ID.");
        }
        const key = `${rootId}:${id}`;
        if (!seen.has(key)) {
          seen.add(key);
          selected.push({ rootId, id });
        }
      }
      const config = readEnv();
      if (!config.PDF_WORK_DIR) throw new Error("PDF_WORK_DIR is not configured.");
      fs.mkdirSync(config.PDF_WORK_DIR, { recursive: true });
      const file = path.join(config.PDF_WORK_DIR, "topic-selection.json");
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({
        enabled: body.enabled === true && selected.length > 0,
        selected
      }, null, 2) + "\n");
      fs.renameSync(temporary, file);
      addLog(`Topic selection saved: ${selected.length} entries.`);
      return send(res, 200, { ok: true, count: selected.length });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/catalogue") {
    try {
      const config = readEnv();
      const sourceRoot = config.WORKSHOP_SOURCE_DIR;
      const treeRoot = config.WORKSHOP_TREE_DIR;

      if (!sourceRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
        throw new Error("Workshop source folder is missing or inaccessible.");
      }
      if (!treeRoot || !fs.existsSync(treeRoot) || !fs.statSync(treeRoot).isDirectory()) {
        throw new Error("Workshop tree folder is missing or inaccessible.");
      }

      const publisher = await getPublisherScanner();
      const discovered = await publisher.scanFilesystemLibrary({
        id: "workshop-assets",
        root: sourceRoot
      });

      const eligible = discovered.filter(item =>
        item.isLatestRevision !== false &&
        item.wrlName &&
        item.xmlName &&
        item.instructionCount > 0
      );

      const index = await loadWorkshopTreeIndex(treeRoot);
      const plan = buildWorkshopTreePlan(eligible, index);
      const entriesByKey = new Map();

      for (const entry of [...plan.entries, ...plan.unmatchedEntries]) {
        if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, entry);
      }

      const manualsById = new Map();

      for (const publication of plan.publications) {
        const rootId = publication.source?.rootId || "";
        if (!rootId) continue;

        const root = index.roots.find(item => item.id === rootId);
        if (!root) continue;

        const entry = entriesByKey.get(publication.key);
        if (!entry) continue;

        if (!manualsById.has(rootId)) {
          manualsById.set(rootId, {
            id: rootId,
            title: root.title || rootId,
            sectionsByName: new Map()
          });
        }

        const manual = manualsById.get(rootId);
        const pathParts = (entry.path || []).filter(part => part !== manual.title);
        const sectionName = pathParts.length ? pathParts.join(" / ") : "General";

        if (!manual.sectionsByName.has(sectionName)) {
          manual.sectionsByName.set(sectionName, {
            title: sectionName,
            topics: []
          });
        }

        manual.sectionsByName.get(sectionName).topics.push({
          rootId,
          id: publication.id,
          title: entry.title || publication.title,
          instructionCount: publication.instructionCount
        });
      }

      const manuals = [...manualsById.values()].map(manual => ({
        id: manual.id,
        title: manual.title,
        sections: [...manual.sectionsByName.values()]
      }));

      return send(res, 200, {
        eligibleCount: plan.publications.length,
        manuals
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/tree") {
    try {
      const config = readEnv();
      const treeRoot = config.WORKSHOP_TREE_DIR;

      if (!treeRoot || !fs.existsSync(treeRoot) || !fs.statSync(treeRoot).isDirectory()) {
        throw new Error("Workshop tree folder is missing or inaccessible.");
      }

      const index = await loadWorkshopTreeIndex(treeRoot);

      return send(res, 200, {
        treeDirectory: index.treeDirectory,
        roots: index.roots
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    try {
      if (running) return send(res, 409, { error: "Stop the publisher before changing settings." });
      const body = await readBody(req);
      const values = {};
      for (const key of allowed) {
        if (body[key] !== undefined) {
          const value = String(body[key]).trim();
          if (/[\r\n\0]/.test(value)) throw new Error(`Invalid value for ${key}`);
          values[key] = value;
        }
      }
      saveEnv(values);
      addLog("Settings saved.");
      return send(res, 200, { ok: true, config: readEnv() });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    if (running) return send(res, 409, { error: "A publishing job is already running." });
    try {
      const request = await readBody(req);
      const config = readEnv();
      for (const key of ["WORKSHOP_SOURCE_DIR", "WORKSHOP_RUNTIME_DIR", "WORKSHOP_TREE_DIR"]) {
        if (!config[key] || !fs.existsSync(config[key]) || !fs.statSync(config[key]).isDirectory()) {
          throw new Error(`${key} is missing or is not an accessible directory: ${config[key] || "(empty)"}`);
        }
      }
      for (const key of ["PDF_OUTPUT_DIR", "PDF_WORK_DIR"]) {
        if (!config[key]) throw new Error(`${key} is not configured.`);
        fs.mkdirSync(config[key], { recursive: true });
      }
      if (!/^\d+$/.test(config.PDF_SAMPLE_SIZE ?? "0")) {
        throw new Error("PDF_SAMPLE_SIZE must be 0 or a positive whole number.");
      }

      const sampleSize = Number(config.PDF_SAMPLE_SIZE ?? "0");
      const selectionPath = path.join(config.PDF_WORK_DIR, "topic-selection.json");
      let savedSelection = { enabled: false, selected: [] };
      if (fs.existsSync(selectionPath)) {
        savedSelection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
      }
      const selectionEnabled = savedSelection.enabled === true &&
        Array.isArray(savedSelection.selected) && savedSelection.selected.length > 0;
      const mode = request.mode;

      if (!["sample", "selection", "all"].includes(mode)) {
        throw new Error("Choose sample, saved selection, or full library before starting.");
      }
      if (mode === "sample" && sampleSize < 1) {
        throw new Error("A sample requires a positive sample size.");
      }
      if (mode === "selection" && (sampleSize !== 0 || !selectionEnabled)) {
        throw new Error("Saved-selection mode requires sample size 0 and a non-empty saved selection.");
      }
      if (mode === "all" && (sampleSize !== 0 || request.allowFullLibrary !== true)) {
        throw new Error("Full-library publishing requires sample size 0 and explicit confirmation.");
      }

      if (mode === "sample" || mode === "all") {
        const temporarySelection = path.join(config.PDF_WORK_DIR, "publisher-unfiltered-selection.json");
        fs.writeFileSync(temporarySelection,
          JSON.stringify({ enabled: false, selected: [] }, null, 2) + "\n",
          { mode: 0o600 });
      }

      const gpuMode = config.PDF_GPU_MODE || "off";
      if (!["off", "brave-cdp"].includes(gpuMode)) {
        throw new Error("PDF_GPU_MODE must be off or brave-cdp.");
      }

      const composeArgs = ["compose"];
      if (gpuMode === "brave-cdp") {
        if (!fs.existsSync(path.join(ROOT, "docker-compose.gpu.yml"))) {
          throw new Error("GPU Compose override is missing.");
        }
        composeArgs.push("-f", "docker-compose.yml", "-f", "docker-compose.gpu.yml");
        addLog("Hardware rendering enabled: using host Brave through CDP.");
      }
      composeArgs.push("run", "--rm");
      if (mode === "sample" || mode === "all") {
        composeArgs.push("-e", "PDF_SELECTION_FILE=/work/publisher-unfiltered-selection.json");
      }
      composeArgs.push("workshop-pdf");

      logs = [];
      exitCode = null;
      startedAt = new Date().toISOString();
      addLog(`Starting Docker PDF publisher in ${mode} mode...`);
      running = true;
      child = spawn("docker", composeArgs, {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", data => addLog(data.toString()));
      child.stderr.on("data", data => addLog(data.toString()));
      child.on("error", error => {
        addLog(`Could not start Docker: ${error.message}`);
        running = false;
        exitCode = 1;
        child = null;
      });
      child.on("close", code => {
        addLog(`Publisher process finished with exit code ${code}.`);
        running = false;
        exitCode = code;
        child = null;
      });
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    if (!running || !child) return send(res, 409, { error: "No publishing job is running." });
    addLog("Stop requested. Sending interrupt to Docker Compose...");
    child.kill("SIGINT");
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/open-output") {
    const output = readEnv().PDF_OUTPUT_DIR;
    if (!output || !fs.existsSync(output)) return send(res, 400, { error: "Output folder does not exist yet." });
    const opener = spawn("xdg-open", [output], { detached: true, stdio: "ignore" });
    opener.unref();
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(ROOT, "control-panel", "index.html")));
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Workshop PDF Control Panel: http://${HOST}:${PORT}`);
  console.log("Local computer only; not exposed to the network.");
});
