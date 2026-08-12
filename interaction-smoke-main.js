import { app } from 'electron';

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

let interactionSmokeComplete = false;

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
      visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      isTarget: Boolean(hit && (hit === target || target.contains(hit))),
      stack
    };
  })()`);
}

async function navPoint(webContents, viewName) {
  return pointForSelector(webContents, `.nav-button[data-view=${JSON.stringify(viewName)}]`, { scroll: true });
}

function describeBlocker(point) {
  if (point && !point.visible) return 'a target outside the visible Electron viewport';
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

async function closeDialog(webContents, id) {
  return webContents.executeJavaScript(`(() => {
    const dialog = document.getElementById(${JSON.stringify(id)});
    if (dialog?.open) dialog.close();
    return Boolean(dialog && !dialog.open);
  })()`);
}

async function notificationState(webContents) {
  return webContents.executeJavaScript(`(() => {
    const layer = document.getElementById('notificationLayer');
    const region = document.getElementById('updateNotificationRegion');
    return {
      layerHidden: Boolean(layer?.hidden),
      regionHidden: Boolean(region?.hidden),
      hasPopoverAttribute: Boolean(layer?.hasAttribute('popover'))
    };
  })()`);
}

async function assertNavigationClick(browserWindow, viewName, label) {
  const point = await navPoint(browserWindow.webContents, viewName);
  if (!point || !point.visible || !point.isTarget) {
    throw new Error(`${label} click target is obscured by ${describeBlocker(point)}.`);
  }
  sendClick(browserWindow.webContents, point);
  await delay(140);
  if (!await viewIsActive(browserWindow.webContents, viewName)) {
    throw new Error(`${label} did not activate from a real mouse click.`);
  }
}

async function assertDashboardControl(browserWindow, phase) {
  const customise = await pointForSelector(browserWindow.webContents, '#customiseDashboardButton');
  if (!customise || !customise.visible || !customise.isTarget) {
    throw new Error(`${phase} Dashboard control is obscured by ${describeBlocker(customise)}.`);
  }
  sendClick(browserWindow.webContents, customise);
  await delay(140);
  if (!await dialogIsOpen(browserWindow.webContents, 'dashboardDialog')) {
    throw new Error(`${phase} Dashboard customisation did not open from a real mouse click.`);
  }
  await closeDialog(browserWindow.webContents, 'dashboardDialog');
}

if (process.argv.includes('--capture-ui')) {
  app.on('before-quit', (event) => {
    if (!interactionSmokeComplete) event.preventDefault();
  });

  app.on('browser-window-created', (_event, browserWindow) => {
    browserWindow.webContents.once('did-finish-load', async () => {
      await delay(650);
      try {
        await assertNavigationClick(browserWindow, 'settings', 'Early Settings');
        await assertNavigationClick(browserWindow, 'dashboard', 'Early Dashboard');
        await assertDashboardControl(browserWindow, 'Early');

        await delay(3600);
        browserWindow.webContents.send('update:status', {
          state: 'available',
          message: 'A newer OneStep Money version is available.',
          version: '9.9.9',
          currentVersion: app.getVersion()
        });
        await delay(250);

        const notification = await notificationState(browserWindow.webContents);
        if (!notification || notification.regionHidden || notification.layerHidden) {
          throw new Error('Delayed update notification did not become visible for interaction verification.');
        }
        if (notification.hasPopoverAttribute) {
          throw new Error('Notification layer still uses the browser Popover top layer.');
        }

        await assertNavigationClick(browserWindow, 'settings', 'Delayed Settings');
        await assertNavigationClick(browserWindow, 'dashboard', 'Delayed Dashboard');
        await assertDashboardControl(browserWindow, 'Delayed');

        interactionSmokeComplete = true;
        console.log('Electron delayed interaction smoke passed.');
        app.quit();
      } catch (error) {
        interactionSmokeComplete = true;
        console.error(`Electron interaction smoke failed: ${error.message}`);
        app.exit(1);
      }
    });
  });
}
