from pathlib import Path
import re


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected exactly one replacement target, found {text.count(old)}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'index.html',
    '<div id="notificationLayer" class="notification-layer" popover="manual">',
    '<div id="notificationLayer" class="notification-layer">'
)

renderer = Path('renderer-app.js')
renderer_text = renderer.read_text(encoding='utf-8')
pattern = re.compile(
    r"function initialiseNotificationLayer\(\) \{.*?\n\}\nfunction syncNotificationLayer\(promote = false\) \{.*?\n\}\nfunction showToast\(message\) \{",
    re.S
)
replacement = """function initialiseNotificationLayer() {
  syncNotificationLayer();
}
function syncNotificationLayer() {
  const layer = byId('notificationLayer');
  const shouldShow = !byId('toast').hidden || !byId('updateNotificationRegion').hidden;
  layer.hidden = !shouldShow;
}
function showToast(message) {"""
renderer_text, count = pattern.subn(replacement, renderer_text, count=1)
if count != 1:
    raise SystemExit(f'renderer-app.js: expected notification function block once, found {count}')
renderer.write_text(renderer_text, encoding='utf-8')

css = Path('styles.css')
css_text = css.read_text(encoding='utf-8')
backdrop = '.notification-layer::backdrop { background: transparent; pointer-events: none; }\n'
if css_text.count(backdrop) != 1:
    raise SystemExit(f'styles.css: expected notification backdrop rule once, found {css_text.count(backdrop)}')
css.write_text(css_text.replace(backdrop, '', 1), encoding='utf-8')

preload = Path('preload-bridge.cjs')
preload_text = preload.read_text(encoding='utf-8')
preload_pattern = re.compile(
    r"\nfunction installNotificationLayerMainWorldGuard\(\) \{.*?\n\}\n\ninstallNotificationLayerMainWorldGuard\(\);\n",
    re.S
)
preload_text, count = preload_pattern.subn('\n', preload_text, count=1)
if count != 1:
    raise SystemExit(f'preload-bridge.cjs: expected main-world guard once, found {count}')
harden_pattern = re.compile(
    r"function hardenInitialInteractionSurface\(\) \{.*?\n\}\n\nfunction loadCoreInteractionModule",
    re.S
)
harden_replacement = """function hardenInitialInteractionSurface() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
}

function loadCoreInteractionModule"""
preload_text, count = harden_pattern.subn(harden_replacement, preload_text, count=1)
if count != 1:
    raise SystemExit(f'preload-bridge.cjs: expected interaction hardening block once, found {count}')
preload.write_text(preload_text, encoding='utf-8')

smoke = r'''import { app } from 'electron';

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
'''
Path('interaction-smoke-main.js').write_text(smoke, encoding='utf-8')

ui_test = Path('tests/interaction-ui.test.js')
ui_text = ui_test.read_text(encoding='utf-8')
test_pattern = re.compile(
    r"test\('all transient and update notifications share a promoted browser top layer', async \(\) => \{.*?\n\}\);\n\n(?=test\('Review Inbox)",
    re.S
)
test_replacement = r'''test('transient and update notifications stay above the app without entering the browser top layer', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="notificationLayer" class="notification-layer"[\s\S]+id="updateNotificationRegion"[\s\S]+id="toast"/);
  assert.doesNotMatch(html, /id="notificationLayer"[^>]+popover=/);
  assert.match(renderer, /const shouldShow = !byId\('toast'\)\.hidden \|\| !byId\('updateNotificationRegion'\)\.hidden/);
  assert.match(renderer, /layer\.hidden = !shouldShow/);
  assert.doesNotMatch(renderer, /showPopover|hidePopover|:popover-open/);
  assert.match(css, /\.notification-layer \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 2147483647[^}]*pointer-events: none/);
  assert.match(css, /\.update-notification-region \{[^}]*pointer-events: auto/);
  assert.doesNotMatch(css, /\.notification-layer::backdrop/);
});

'''
ui_text, count = test_pattern.subn(lambda _match: test_replacement, ui_text, count=1)
if count != 1:
    raise SystemExit(f'tests/interaction-ui.test.js: expected top-layer test once, found {count}')
ui_test.write_text(ui_text, encoding='utf-8')

delayed_test = r'''import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('delayed packaged-style update status cannot take mouse interaction away from the app', async () => {
  const [html, renderer, preload, smoke] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../preload-bridge.cjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../interaction-smoke-main.js', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(html, /id="notificationLayer"[^>]+popover=/);
  assert.doesNotMatch(renderer, /showPopover|hidePopover|:popover-open/);
  assert.doesNotMatch(preload, /executeInMainWorld|Element\.prototype\.matches|HTMLElement\.prototype\.(?:showPopover|hidePopover)/);
  assert.match(smoke, /await delay\(3600\)/);
  assert.match(smoke, /webContents\.send\('update:status'/);
  assert.match(smoke, /Delayed Settings/);
  assert.match(smoke, /Delayed Dashboard/);
  assert.match(smoke, /assertDashboardControl\(browserWindow, 'Delayed'\)/);
  assert.match(smoke, /hasPopoverAttribute/);
  assert.match(smoke, /before-quit/);
});
'''
Path('tests/delayed-interaction.test.js').write_text(delayed_test, encoding='utf-8')
