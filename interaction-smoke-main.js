import { app } from 'electron';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function navPoint(webContents, viewName) {
  return webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.nav-button')].find((item) => item.dataset.view === ${JSON.stringify(viewName)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      hitView: hit?.closest?.('.nav-button')?.dataset?.view || ''
    };
  })()`);
}

function sendClick(webContents, point) {
  webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function viewIsActive(webContents, viewName) {
  return webContents.executeJavaScript(`(() => {
    const view = document.getElementById(${JSON.stringify(`view-${viewName}`)});
    return Boolean(view && !view.hidden && view.classList.contains('active'));
  })()`);
}

if (process.argv.includes('--capture-ui')) {
  app.on('browser-window-created', (_event, browserWindow) => {
    browserWindow.webContents.once('did-finish-load', async () => {
      await delay(650);
      try {
        const settings = await navPoint(browserWindow.webContents, 'settings');
        if (!settings || settings.hitView !== 'settings') throw new Error('Sidebar click target is obscured.');
        sendClick(browserWindow.webContents, settings);
        await delay(120);
        if (!await viewIsActive(browserWindow.webContents, 'settings')) throw new Error('Settings did not activate from a real mouse click.');

        const dashboard = await navPoint(browserWindow.webContents, 'dashboard');
        if (!dashboard || dashboard.hitView !== 'dashboard') throw new Error('Dashboard click target is obscured.');
        sendClick(browserWindow.webContents, dashboard);
        await delay(120);
        if (!await viewIsActive(browserWindow.webContents, 'dashboard')) throw new Error('Dashboard did not reactivate from a real mouse click.');

        console.log('Electron interaction smoke passed.');
      } catch (error) {
        console.error(`Electron interaction smoke failed: ${error.message}`);
        app.exit(1);
      }
    });
  });
}
