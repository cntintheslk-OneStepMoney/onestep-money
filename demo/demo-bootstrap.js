(() => {
  const failureDelay = 2500;
  const timer = window.setTimeout(showStartupFailure, failureDelay);

  window.addEventListener('onestep-demo-ready', () => {
    window.clearTimeout(timer);
    document.documentElement.dataset.demoStartup = 'ready';
    const failure = document.getElementById('demoStartupError');
    if (failure) failure.hidden = true;
  }, { once: true });

  function showStartupFailure() {
    if (document.documentElement.dataset.demoStartup === 'ready') return;
    document.documentElement.dataset.demoStartup = 'failed';
    const welcome = document.getElementById('demoWelcome');
    if (welcome) welcome.removeAttribute('open');
    const shell = document.getElementById('demoShell');
    if (shell) {
      shell.hidden = true;
      shell.setAttribute('aria-hidden', 'true');
    }
    const failure = document.getElementById('demoStartupError');
    if (failure) failure.hidden = false;
  }
})();
