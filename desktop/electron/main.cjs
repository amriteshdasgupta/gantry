// Gantry as a desktop app: starts the bundled Next.js server and shows it in a native window.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, utilityProcess } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEV_URL = process.env.PR_LENS_DEV_URL; // e.g. http://localhost:3000 while developing
let server = null;
let gantryServer = null;
let baseUrl = null;
let mainWindow = null;
let pendingReview = null;

// Only accept a GitHub PR identity, never an arbitrary navigation target.
function reviewPath(link) {
  try {
    const url = new URL(link);
    if (url.protocol !== "pr-lens:" || url.hostname !== "review" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function openReview(link) {
  const route = reviewPath(link);
  if (!route) return;
  pendingReview = route;
  if (!baseUrl) return; // macOS delivers open-url before ready on cold starts.
  if (!mainWindow) createWindow();
  else {
    pendingReview = null;
    mainWindow.loadURL(`${baseUrl}${route}`);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  openReview(url);
});
for (const arg of process.argv) {
  if (reviewPath(arg)) pendingReview = reviewPath(arg);
}

// Isolate test/development windows from the installed app's single-instance lock.
// Preserve the existing desktop profile when renaming the app.
app.setName("Gantry");
app.setPath("userData", process.env.PR_LENS_USER_DATA ? path.resolve(process.env.PR_LENS_USER_DATA) : path.join(app.getPath("appData"), "PR Lens"));
if (!app.requestSingleInstanceLock()) app.quit();

/** Apps opened from Finder get a bare PATH; borrow the login shell's for local CLIs. */
function loginShellPath() {
  if (process.platform === "win32") return process.env.PATH || process.env.Path || "";
  const shellBin = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shellBin, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000, encoding: "utf8" });
    const m = out.match(/__PATH__(.*)__PATH__/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(app.getPath("home"), ".local/bin")].filter(Boolean).join(":");
}

function codexExecutable(searchPath) {
  if (process.env.PR_LENS_CODEX) return process.env.PR_LENS_CODEX;
  const candidates = searchPath.split(path.delimiter).filter(Boolean).flatMap((dir) => (process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"]).map(name => path.join(dir.replace(/^"|"$/g, ""), name)));
  // The desktop app's CLI is not necessarily installed on the login shell's PATH.
  for (const root of ["/Applications", path.join(app.getPath("home"), "Applications")]) {
    candidates.push(
      path.join(root, "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
      path.join(root, "Codex.app/Contents/Resources/codex"),
    );
  }
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || "codex";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The Gantry server didn't start within ${ms / 1000}s.`);
}

async function startGantry() {
  if (process.env.PR_LENS_GANTRY_DISABLED === "1") return;
  const address = process.env.PR_LENS_GANTRY_URL || "http://127.0.0.1:4500";
  const url = new URL(address);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Gantry must use a local HTTP address.");
  try {
    const response = await fetch(`${url.origin}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (response.ok && typeof (await response.json()).version === "string") return;
  } catch { /* Start the bundled service when no existing Gantry is running. */ }
  const dir = app.isPackaged ? path.join(process.resourcesPath, "gantry") : path.join(__dirname, "..", ".gantry-runtime");
  const entry = path.join(dir, "packages/cli/bin/gantry.js");
  if (!fs.existsSync(entry)) throw new Error("Gantry runtime is missing. Rebuild with PR_LENS_GANTRY_SOURCE set to its repository.");
  const logFile = path.join(app.getPath("logs"), "gantry.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const searchPath = loginShellPath();
  gantryServer = utilityProcess.fork(entry, ["serve"], {
    cwd: dir, stdio: "pipe", serviceName: "Gantry service",
    env: { ...process.env, PATH: searchPath, GANTRY_CODEX_BINARY: codexExecutable(searchPath), GANTRY_HOST: url.hostname, GANTRY_PORT: url.port || "80", GANTRY_UI_DIR: path.join(dir, "packages/ui/dist") },
  });
  gantryServer.stdout?.pipe(log);
  gantryServer.stderr?.pipe(log);
  gantryServer.once("exit", () => { gantryServer = null; });
  await waitFor(`${url.origin}/api/version`, 30000);
}

async function startServer() {
  if (DEV_URL) return DEV_URL;
  const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", ".next", "standalone");
  const entry = path.join(dir, "server.js");
  if (!fs.existsSync(entry)) throw new Error(`Missing ${entry}. Run "npm run app:bundle" first.`);
  const port = await freePort();
  const logFile = path.join(app.getPath("logs"), "server.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const searchPath = loginShellPath();
  server = utilityProcess.fork(entry, [], {
    cwd: dir,
    stdio: "pipe",
    serviceName: "Gantry server",
    env: { ...process.env, PATH: searchPath, PR_LENS_CODEX: codexExecutable(searchPath), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" },
  });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  server.on("exit", (code) => {
    server = null;
    if (!app.isQuitting) dialog.showErrorBox("Gantry", `The server stopped (code ${code}). See ${logFile}.`);
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(url);
  return url;
}

function isInternal(url) {
  try {
    return baseUrl && new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: "Gantry",
    // No title bar: the app's own 48px top bar is the title bar, with the traffic lights
    // centred in it (trafficLightPosition only applies to "hidden", not "hiddenInset").
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  // GitHub links and anything else outside the app open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, sandbox: true } } };
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!isInternal(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on("closed", () => (mainWindow = null));
  const route = pendingReview || (process.env.PR_LENS_GANTRY_DISABLED === "1" ? "/reviews" : "/");
  pendingReview = null;
  mainWindow.loadURL(`${baseUrl}${route}`);
}

function buildMenu() {
  const go = (p) => mainWindow?.loadURL(`${baseUrl}${p}`);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: process.platform === "darwin" ? undefined : "File",
        role: process.platform === "darwin" ? "appMenu" : undefined,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => go("/settings") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "Go",
        submenu: [
          { label: "Gantry", accelerator: "CmdOrCtrl+Shift+G", click: () => go("/") },
          { label: "Reviews", accelerator: "CmdOrCtrl+Shift+H", click: () => go("/reviews") },
          { label: "Back", accelerator: "CmdOrCtrl+[", click: () => mainWindow?.webContents.navigationHistory.goBack() },
          { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => mainWindow?.webContents.navigationHistory.goForward() },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.on("second-instance", (_event, argv) => {
  const link = argv.find((arg) => reviewPath(arg));
  if (link) openReview(link);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  server?.kill();
  gantryServer?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow && baseUrl) createWindow();
});

ipcMain.handle("pick-folder", async (event) => {
  if (!isInternal(event.senderFrame?.url)) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ["openDirectory"] });
  return canceled ? null : filePaths[0];
});

app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient("pr-lens");
  try {
    // Review remains usable even if an existing Gantry service cannot start.
    try { await startGantry(); } catch (error) { console.error("Gantry startup:", error.message); }
    baseUrl = await startServer();
  } catch (e) {
    dialog.showErrorBox("Gantry couldn't start", e.message);
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
});
