// Exposes the native folder picker to the app; nothing else crosses the bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gantryDesktop", { pickFolder: () => ipcRenderer.invoke("pick-folder") });
