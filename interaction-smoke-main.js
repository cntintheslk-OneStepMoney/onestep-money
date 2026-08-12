import { app } from 'electron';

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function pointForSelector(webContents, selector, { scroll = false } = {}) {
  return webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return null;
    if (${scroll ? 'true' : 'false'}) target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    const stack = document.elementsFromPoint(x, y).slice(0, 6).map((element) => ({
      tag: element.tagName?.toLowerCase?.() || '',
      id: element.id || '',
      className: element.getAttribute?.('class') || '',
      pointerEvents: getComputedStyle(element).pointerEvents
    }));
    return {
      x,
      y,
      isTarget: Boolean(hit && (hit === target || target.contains(hit))),
      stack
    };
  })()`);
}

async function navPoint(webContents, viewName) {
  return pointForSelector(webContents, `.nav-button[data-view=${JSON.stringify(viewName)}]`, { scroll: true });
}

function describeBlocker(point) {
  const blocker = point?.stack?.[0];
  if (!blocker) return 'unknown element';
  const id = blocker.id ? `#${blocker.id}` : '';
  const classes = blocker.className
    ? `.${blocker.className.trim().split(/\s+/).filter(Boolean).join('.')}`
    : '';
  return `${blocker.tag || 'element'}${id}${classes} (pointer-events: ${blocker.pointerEvents || 'unknown'})`;
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

async function dialogIsOpen(webContents, id) {
  return webContents.executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(id)})?.open)`);
}

if (process.argv.includes('--capture-ui')) {
  app.on('browser-window-created', (_event, browserWindow) => {
    browserWindow.webContents.once('did-finish-load', async () => {
      await delay(650);
      try {
        const settings = await navPoint(browserWindow.webContents, 'settings');
        if (!settings || !settings.isTarget) {
          throw new Error(`Sidebar Settings click target is obscured by ${describeBlocker(settings)}.`);
        }
        sendClick(browserWindow.webContents, settings);
        await delay(120);
        if (!await viewIsActive(browserWindow.webContents, 'settings')) throw new Error('Settings did not activate from a real mouse click.');

        const dashboard = await navPoint(browserWindow.webContents, 'dashboard');
        if (!dashboard || !dashboard.isTarget) {
          throw new Error(`Dashboard click target is obscured by ${describeBlocker(dashboard)}.`);
        }
        sendClick(browserWindow.webContents, dashboard);
        await delay(120);
        if (!await viewIsActive(browserWindow.webContents, 'dashboard')) throw new Error('Dashboard did not reactivate from a real mouse click.');

        const customise = await pointForSelector(browserWindow.webContents, '#customiseDashboardButton');
        if (!customise || !customise.isTarget) {
          throw new Error(`Dashboard control is obscured by ${describeBlocker(customise)}.`);
        }
        sendClick(browserWindow.webContents, customise);
        await delay(120);
        if (!await dialogIsOpen(browserWindow.webContents, 'dashboardDialog')) {
          throw new Error('Dashboard customisation did not open from a real mouse click.');
        }

        console.log('Electron interaction smoke passed.');
      } catch (error) {
        console.error(`Electron interaction smoke failed: ${error.message}`);
        app.exit(1);
      }
    });
  });
}
