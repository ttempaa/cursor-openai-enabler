# cursor-openai-enabler

Cursor IDE extension that automatically re-enables the "OpenAI API Key" toggle when it randomly resets itself.

## Problem

Cursor has a [known bug](https://forum.cursor.com/t/openai-api-key-randomly-toggling-off-in-settings/24724) where the "Override OpenAI Base URL" / "OpenAI API Key" toggle keeps turning off by itself. There is no official fix yet.

## How it works

1. The extension reads Cursor's internal SQLite database (`state.vscdb`) to detect when `useOpenAIKey` resets to `false`
2. When detected, it calls Cursor's built-in `aiSettings.usingOpenAIKey.toggle` command to re-enable it
3. Shows a notification when the fix is applied

Detection runs via:
- **File watcher** on `state.vscdb` (reacts in ~1 second)
- **Polling fallback** every 30 seconds

### Toggle button

A status bar button (`OpenAI Key`) lets you pause and resume the extension without disabling it. This is useful when you want to switch to a different model temporarily.

- Click the button or use `Ctrl+Shift+P` → "Cursor OpenAI Enabler: Toggle On/Off"
- When paused, all monitoring stops completely (no polling, no file watching)
- When paused, the extension also turns off the OpenAI key toggle in Cursor
- When resumed, the extension immediately checks the setting and re-enables it if needed
- The state persists across Cursor restarts

Works on **Windows, macOS, and Linux**.

### Logs

The extension writes diagnostic messages to the Output panel:

- Open `View` → `Output`
- Select `Cursor OpenAI Enabler`
- Log lines include timestamps with milliseconds

## Install

### From release

1. Download the latest `.vsix` from [Releases](https://github.com/ttempaa/cursor-openai-enabler/releases)
2. Install via CLI:
   ```
   cursor --install-extension cursor-openai-enabler-x.x.x.vsix
   ```
   Or in Cursor: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."

### Build from source

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run build
bun run package
```

## How it finds the database

The path is derived automatically from the extension's `globalStorageUri`, so it works regardless of OS:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
