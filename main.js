const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;

// Isolated profile for automated tests (test/e2e.js).
if (process.env.MYOB_USER_DATA) app.setPath('userData', process.env.MYOB_USER_DATA);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    title: 'my_obsidian',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      // Local personal tool: the renderer needs direct fs access to the vault.
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Open target="_blank" / external navigations in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

ipcMain.handle('choose-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 Vault 資料夾',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('choose-save-file', async (_event, { title, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: defaultName,
    filters
  });
  return result.canceled ? null : result.filePath;
});

// Render a standalone HTML file in a hidden window and print it to PDF.
ipcMain.handle('export-pdf', async (_event, { htmlPath, outPath }) => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 }
    });
    fs.writeFileSync(outPath, pdf);
    return outPath;
  } finally {
    win.destroy();
  }
});

ipcMain.handle('choose-export-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇匯出目的地資料夾',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('reveal-in-finder', (_event, targetPath) => {
  shell.showItemInFolder(targetPath);
});

ipcMain.handle('trash-item', (_event, targetPath) => shell.trashItem(targetPath));

ipcMain.handle('open-external', (_event, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
