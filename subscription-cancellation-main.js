import { ipcMain, shell } from 'electron';
import { validateExternalDestination } from './subscription-cancellation.js';

ipcMain.handle('subscription:open-cancellation', async (_event, destination) => {
  let url;
  try { url = validateExternalDestination(destination); }
  catch { return { opened: false, reasonCode: 'invalid_destination' }; }
  try {
    await shell.openExternal(url);
    return { opened: true };
  } catch {
    return { opened: false, reasonCode: 'open_failed' };
  }
});
