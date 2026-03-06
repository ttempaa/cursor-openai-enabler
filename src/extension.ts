import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import initSqlJs from "sql.js";

const execFileAsync = promisify(execFile);

const STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const TOGGLE_COMMAND = "aiSettings.usingOpenAIKey.toggle";

let pollInterval: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let initialTimeout: ReturnType<typeof setTimeout> | undefined;
let sqlPromise: ReturnType<typeof initSqlJs>;
let sqlite3Path: string | undefined;
let statusBarItem: vscode.StatusBarItem;
let isEnabled = true;
let watcher: vscode.FileSystemWatcher | undefined;
let checkAndFix: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
  const stateDbPath = path.join(globalStorageDir, "state.vscdb");

  if (!fs.existsSync(stateDbPath)) {
    console.log("cursor-openai-enabler: state.vscdb not found, skipping.");
    return;
  }

  sqlite3Path = await findSqlite3();

  const wasmPath = path.join(context.extensionPath, "dist", "sql-wasm.wasm");
  sqlPromise = initSqlJs({ locateFile: () => wasmPath });

  checkAndFix = createChecker(stateDbPath);

  // Restore saved state
  isEnabled = context.globalState.get<boolean>("enabled", true);

  // Status bar toggle button
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursor-openai-enabler.toggle";
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Toggle command
  const toggleCmd = vscode.commands.registerCommand(
    "cursor-openai-enabler.toggle",
    () => {
      isEnabled = !isEnabled;
      context.globalState.update("enabled", isEnabled);
      updateStatusBar();
      if (isEnabled) {
        startMonitoring(globalStorageDir, stateDbPath, context);
      } else {
        stopMonitoring();
      }
      vscode.window.showInformationMessage(
        `Cursor OpenAI Enabler: ${isEnabled ? "activated" : "paused"}`
      );
    }
  );
  context.subscriptions.push(toggleCmd);

  if (isEnabled) {
    startMonitoring(globalStorageDir, stateDbPath, context);
  }
}

function updateStatusBar() {
  if (isEnabled) {
    statusBarItem.text = "$(check) OpenAI Key";
    statusBarItem.tooltip = "Cursor OpenAI Enabler: Active (click to pause)";
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(circle-slash) OpenAI Key";
    statusBarItem.tooltip = "Cursor OpenAI Enabler: Paused (click to activate)";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  statusBarItem.show();
}

function startMonitoring(
  globalStorageDir: string,
  stateDbPath: string,
  context: vscode.ExtensionContext
) {
  if (!checkAndFix) return;

  // Initial check (with delay to let Cursor fully initialize)
  initialTimeout = setTimeout(checkAndFix, 3000);

  // File watcher (debounced)
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(globalStorageDir), "state.vscdb")
  );
  const fn = checkAndFix;
  watcher.onDidChange(() => {
    if (!isEnabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fn, 1000);
  });
  context.subscriptions.push(watcher);

  // Polling fallback every 30s
  pollInterval = setInterval(() => {
    if (isEnabled) fn();
  }, 30_000);
}

function stopMonitoring() {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = undefined;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  if (watcher) {
    watcher.dispose();
    watcher = undefined;
  }
}

export function deactivate() {
  stopMonitoring();
  if (statusBarItem) statusBarItem.dispose();
}

async function findSqlite3(): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, ["sqlite3"]);
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

async function readUseOpenAIKey(dbPath: string): Promise<boolean | undefined> {
  // Prefer sqlite3 CLI for proper WAL handling
  if (sqlite3Path) {
    try {
      const { stdout } = await execFileAsync(sqlite3Path, [
        dbPath,
        `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}';`,
      ]);
      const raw = stdout.trim();
      if (!raw) return undefined;
      return JSON.parse(raw).useOpenAIKey;
    } catch {
      // Fall through to sql.js
    }
  }

  const SQL = await sqlPromise;
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  try {
    const result = db.exec(
      `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}'`
    );
    if (!result.length || !result[0].values.length) return undefined;
    return JSON.parse(result[0].values[0][0] as string).useOpenAIKey;
  } finally {
    db.close();
  }
}

function createChecker(stateDbPath: string) {
  let running = false;

  return async function checkAndFix() {
    if (running) return;
    running = true;

    try {
      const enabled = await readUseOpenAIKey(stateDbPath);

      if (enabled === false) {
        // Toggle it ON via Cursor's own command
        await vscode.commands.executeCommand(TOGGLE_COMMAND);

        vscode.window.showInformationMessage(
          "Cursor OpenAI Enabler: re-enabled OpenAI API Key toggle."
        );
        console.log("cursor-openai-enabler: toggled useOpenAIKey back to true");
      }
    } catch (err) {
      console.error("cursor-openai-enabler:", err);
    } finally {
      running = false;
    }
  };
}
