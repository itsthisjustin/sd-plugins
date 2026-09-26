// Pomodoro Timer — simple work/break focus timer for the SD-card plugin loader.
// Copy this folder to /.crosspoint/plugins/pomodoro/ on the SD card; the settings
// page discovers it via /api/plugins, serves it via /plugin, and runs it here.
CrossPoint.registerPlugin((container, api) => {
  const STORAGE_KEY = 'pomodoro-settings';

  const defaults = {
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    sessionsBeforeLongBreak: 4,
  };

  function loadSettings() {
    try {
      const saved = api && api.storage && api.storage.get
        ? api.storage.get(STORAGE_KEY)
        : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return Object.assign({}, defaults, saved || {});
    } catch (e) {
      return Object.assign({}, defaults);
    }
  }

  function saveSettings(settings) {
    try {
      if (api && api.storage && api.storage.set) {
        api.storage.set(STORAGE_KEY, settings);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      }
    } catch (e) { /* storage unavailable, ignore */ }
  }

  const settings = loadSettings();

  let mode = 'work';       // 'work' | 'break' | 'longBreak'
  let sessionsDone = 0;
  let remainingSeconds = settings.workMinutes * 60;
  let timerId = null;
  let running = false;

  container.innerHTML =
    '<h2>🍅 Pomodoro Timer</h2>' +
    '<div style="text-align:center;margin:1em 0;">' +
      '<div id="pomo-mode" style="font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em;color:var(--label-color);margin-bottom:0.25em;">Focus</div>' +
      '<div id="pomo-time" style="font-size:3em;font-weight:600;font-variant-numeric:tabular-nums;">25:00</div>' +
      '<div id="pomo-sessions" style="font-size:0.85em;color:var(--label-color);margin-top:0.25em;">Sessions completed: 0</div>' +
    '</div>' +
    '<div style="display:flex;gap:0.5em;justify-content:center;margin-bottom:1.5em;">' +
      '<button id="pomo-start" type="button">Start</button>' +
      '<button id="pomo-pause" type="button" disabled>Pause</button>' +
      '<button id="pomo-reset" type="button">Reset</button>' +
    '</div>' +
    '<fieldset style="border:1px solid var(--label-color);border-radius:8px;padding:0.75em 1em;">' +
      '<legend style="font-size:0.85em;color:var(--label-color);">Settings</legend>' +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin:0.4em 0;">Work (min)' +
        '<input id="pomo-work" type="number" min="1" max="120" value="' + settings.workMinutes + '" style="width:4em;"></label>' +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin:0.4em 0;">Short break (min)' +
        '<input id="pomo-break" type="number" min="1" max="60" value="' + settings.breakMinutes + '" style="width:4em;"></label>' +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin:0.4em 0;">Long break (min)' +
        '<input id="pomo-longbreak" type="number" min="1" max="90" value="' + settings.longBreakMinutes + '" style="width:4em;"></label>' +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin:0.4em 0;">Sessions before long break' +
        '<input id="pomo-cycle" type="number" min="1" max="12" value="' + settings.sessionsBeforeLongBreak + '" style="width:4em;"></label>' +
    '</fieldset>';

  const $ = (id) => container.querySelector(id);
  const timeEl = $('#pomo-time');
  const modeEl = $('#pomo-mode');
  const sessionsEl = $('#pomo-sessions');
  const startBtn = $('#pomo-start');
  const pauseBtn = $('#pomo-pause');
  const resetBtn = $('#pomo-reset');
  const workInput = $('#pomo-work');
  const breakInput = $('#pomo-break');
  const longBreakInput = $('#pomo-longbreak');
  const cycleInput = $('#pomo-cycle');

  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  function modeLabel() {
    if (mode === 'work') return 'Focus';
    if (mode === 'longBreak') return 'Long break';
    return 'Short break';
  }

  function render() {
    timeEl.textContent = formatTime(remainingSeconds);
    modeEl.textContent = modeLabel();
    sessionsEl.textContent = 'Sessions completed: ' + sessionsDone;
    startBtn.disabled = running;
    pauseBtn.disabled = !running;
  }

  function notify(message) {
    if (api && typeof api.notify === 'function') {
      api.notify(message);
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(message);
    }
  }

  function switchMode() {
    if (mode === 'work') {
      sessionsDone += 1;
      const cycle = Math.max(1, parseInt(cycleInput.value, 10) || defaults.sessionsBeforeLongBreak);
      if (sessionsDone % cycle === 0) {
        mode = 'longBreak';
        remainingSeconds = Math.max(1, parseInt(longBreakInput.value, 10) || defaults.longBreakMinutes) * 60;
        notify('Nice work! Time for a long break.');
      } else {
        mode = 'break';
        remainingSeconds = Math.max(1, parseInt(breakInput.value, 10) || defaults.breakMinutes) * 60;
        notify('Session done — take a short break.');
      }
    } else {
      mode = 'work';
      remainingSeconds = Math.max(1, parseInt(workInput.value, 10) || defaults.workMinutes) * 60;
      notify('Break over — back to focus.');
    }
    render();
  }

  function tick() {
    remainingSeconds -= 1;
    if (remainingSeconds <= 0) {
      switchMode();
      return;
    }
    render();
  }

  function start() {
    if (running) return;
    running = true;
    timerId = setInterval(tick, 1000);
    render();
  }

  function pause() {
    running = false;
    if (timerId) clearInterval(timerId);
    timerId = null;
    render();
  }

  function reset() {
    pause();
    mode = 'work';
    sessionsDone = 0;
    remainingSeconds = Math.max(1, parseInt(workInput.value, 10) || defaults.workMinutes) * 60;
    render();
  }

  function persistSettings() {
    saveSettings({
      workMinutes: Math.max(1, parseInt(workInput.value, 10) || defaults.workMinutes),
      breakMinutes: Math.max(1, parseInt(breakInput.value, 10) || defaults.breakMinutes),
      longBreakMinutes: Math.max(1, parseInt(longBreakInput.value, 10) || defaults.longBreakMinutes),
      sessionsBeforeLongBreak: Math.max(1, parseInt(cycleInput.value, 10) || defaults.sessionsBeforeLongBreak),
    });
  }

  startBtn.addEventListener('click', start);
  pauseBtn.addEventListener('click', pause);
  resetBtn.addEventListener('click', reset);
  [workInput, breakInput, longBreakInput, cycleInput].forEach((input) => {
    input.addEventListener('change', () => {
      persistSettings();
      if (!running && mode === 'work') {
        remainingSeconds = Math.max(1, parseInt(workInput.value, 10) || defaults.workMinutes) * 60;
        render();
      }
    });
  });

  render();
});
