// Ghost Recorder — Service Worker (background orchestrator)
// - manages extension lifecycle, badge, storage
// - handles offscreen document lifecycle for tab capture & recording
// - coordinates tab capture streamId creation and downloads management

const UNRECORDABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const SETTINGS_DEFAULTS = {
  provider: 'gemini',
  keys: { gemini: '', groq: '', openrouter: '', custom: '', local: '' },
  models: { gemini: 'gemini-3.1-flash-lite', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '', local: 'llama3.2:latest', chrome_ai: 'gemini-nano' },
  groqWhisper: 'whisper-large-v3-turbo',
  customBaseUrl: '',
  localBaseUrl: 'http://localhost:11434/v1',
  saveFolder: 'Ghost Recordings',
  template: 'general',
  recordMode: 'call',
  language: 'auto',
  videoEnabled: true,
  videoResolution: '1080p',
  videoFps: '30',
  videoCodec: 'vp9',
  overlayMode: 'hide_on_video',
  autoSuggest: true,
  consentNote: true,
  email: '',
  emailVia: 'gmail',
  autoEmail: false,
};

let recordingState = {
  isRecording: false,
  tabId: null,
  meetingId: null,
  startTime: null,
  videoEnabled: true,
  platform: 'Unknown',
  pausedAt: null,
};

function derivePlatform(url) {
  if (!url) return 'Unknown';
  if (url.includes('meet.google.com')) return 'Google Meet';
  if (url.includes('zoom.us')) return 'Zoom';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'Microsoft Teams';
  if (url.includes('webex.com')) return 'Webex';
  if (url.includes('discord.com')) return 'Discord';
  if (url.includes('slack.com')) return 'Slack';
  return 'Web';
}

function getSettings() {
  return new Promise((r) => chrome.storage.local.get('settings', ({ settings }) => {
    const s = settings || {};
    r(Object.assign({}, SETTINGS_DEFAULTS, s, {
      keys: Object.assign({}, SETTINGS_DEFAULTS.keys, s.keys || {}),
      models: Object.assign({}, SETTINGS_DEFAULTS.models, s.models || {}),
    }));
  }));
}

function providerKey(settings) {
  if (!settings) return '';
  if (settings.provider === 'local' || settings.provider === 'chrome_ai') return 'local-model-ok';
  if (settings.provider === 'custom') return settings.keys.custom;
  return settings.keys[settings.provider] || '';
}

function getMeetings() { return new Promise((r) => chrome.storage.local.get('meetings', ({ meetings }) => r(meetings || []))); }

let storageChain = Promise.resolve();
function serialize(task) { const run = storageChain.then(task, task); storageChain = run.then(() => {}, () => {}); return run; }
function upsertMeeting(id, patch) {
  return serialize(async () => {
    const list = await getMeetings();
    const sid = String(id).trim();
    let m = list.find((x) => String(x.id).trim() === sid);
    if (!m) {
      if (!patch || (!patch.date && patch.state !== 'recording')) return null;
      m = { id: sid, files: {} };
      list.unshift(m);
    }
    const files = patch.files; const rest = Object.assign({}, patch); delete rest.files;
    Object.assign(m, rest);
    if (files) m.files = Object.assign(m.files || {}, files);
    await chrome.storage.local.set({ meetings: list.slice(0, 100) });
    return m;
  });
}
async function getMeeting(id) {
  const sid = String(id).trim();
  return (await getMeetings()).find((x) => String(x.id).trim() === sid);
}
function deleteMeeting(id) {
  return serialize(async () => {
    const sid = String(id).trim();
    const list = await getMeetings();
    const updated = list.filter((x) => String(x.id).trim() !== sid);
    await chrome.storage.local.set({ meetings: updated });
    await clearCaptions(sid);
    chrome.runtime.sendMessage({ action: 'DELETE_IDB', target: 'offscreen', id: sid }).catch(() => {});
    return true;
  });
}

// Offscreen document creation & management
async function hasOffscreen() {
  if (chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
  const matchedClients = await clients.matchAll();
  return matchedClients.some((c) => c.url.includes('offscreen.html'));
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Captures tab audio and mixes microphone for AI meeting notes.',
  });
}

function sanitizeName(s) {
  return (s || '').replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
}
function folderName(date, platform) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `${dateStr} ${sanitizeName(platform)}`;
}

async function saveFile(meetingId, kind, blob) {
  const m = await getMeeting(meetingId);
  const settings = await getSettings();
  const baseFolder = sanitizeName(settings.saveFolder || 'Ghost Recordings');
  const subFolder = (m && m.folder) || folderName(new Date(m ? m.date : Date.now()), (m && m.platform) || 'Meeting');
  let ext = 'txt';
  let filenameBase = kind;
  if (kind === 'video') ext = 'webm';
  else if (kind === 'audio') ext = 'webm';
  else if (kind === 'notes') ext = 'md';
  else if (kind === 'vtt') { ext = 'vtt'; filenameBase = 'captions'; }
  else if (kind === 'transcript') { ext = 'txt'; filenameBase = 'transcript'; }

  const filename = `${baseFolder}/${subFolder}/${filenameBase}.${ext}`;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) console.error('Download failed:', chrome.runtime.lastError.message);
      else upsertMeeting(meetingId, { files: { [kind]: { filename, downloadId } } });
    });
  };
  reader.readAsDataURL(blob);
}

// ---- caption buffer in storage & WebVTT generator ---------------------------
function formatVttTimestamp(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const msec = Math.floor(ms % 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msec).padStart(3, '0')}`;
}

function buildVttContent(cues) {
  let vtt = 'WEBVTT - Ghost Recorder Meeting Captions\n\n';
  let idx = 1;
  for (const c of cues) {
    const text = (c.text || '').trim();
    if (!text) continue;
    const start = formatVttTimestamp(c.startMs || 0);
    const end = formatVttTimestamp(Math.max((c.startMs || 0) + 1200, c.endMs || ((c.startMs || 0) + 2500)));
    const speaker = (c.speaker || 'Speaker').trim();
    vtt += `${idx}\n${start} --> ${end}\n<v ${speaker}>${text}</v>\n\n`;
    idx++;
  }
  return vtt;
}

function buildTxtTranscript(cues) {
  return cues.map((c) => {
    if (typeof c === 'string') return c;
    const s = Math.max(0, Math.floor((c.startMs || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const stamp = (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `[${stamp}] ${(c.speaker || 'Speaker').trim()}: ${(c.text || '').trim()}`;
  }).join('\n');
}

async function appendCaption(id, cue) {
  return serialize(async () => {
    const key = `caps-${id}`;
    const data = await new Promise((res) => chrome.storage.local.get(key, res));
    const list = data[key] || [];
    list.push(cue);
    await chrome.storage.local.set({ [key]: list.slice(-2000) });
  });
}

async function readCaptionCues(id) {
  const key = `caps-${id}`;
  const data = await new Promise((res) => chrome.storage.local.get(key, res));
  const rawList = data[key] || [];
  return rawList.map((item) => {
    if (typeof item === 'object' && item && item.text) return item;
    if (typeof item === 'string') {
      const m = item.match(/^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^:]+):\s*(.*)$/);
      if (m) {
        const sec = m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
        return { speaker: m[4].trim(), text: m[5].trim(), startMs: sec * 1000, endMs: (sec + 3) * 1000, line: item };
      }
      return { speaker: 'Speaker', text: item, startMs: 0, endMs: 2000, line: item };
    }
    return null;
  }).filter(Boolean);
}

async function readCaptions(id) {
  const cues = await readCaptionCues(id);
  if (!cues.length) return '';
  return buildTxtTranscript(cues);
}

async function clearCaptions(id) {
  await chrome.storage.local.remove(`caps-${id}`);
}

async function buildMeta(id) {
  const m = await getMeeting(id);
  const durSec = recordingState.startTime ? Math.round((Date.now() - recordingState.startTime) / 1000) : 0;
  const h = Math.floor(durSec / 3600), mn = Math.floor((durSec % 3600) / 60), s = durSec % 60;
  const duration = (h ? h + 'h ' : '') + mn + 'm ' + s + 's';
  return {
    date: m ? new Date(m.date).toLocaleString() : new Date().toLocaleString(),
    platform: (m && m.platform) || recordingState.platform || 'Unknown',
    duration,
    title: (m && m.title) || 'Meeting',
  };
}

// --------------------------------------------------------------------------- actions
async function startCapture(tabId) {
  if (tabId == null) throw new Error('No tab to record.');
  if (recordingState.isRecording) throw new Error('Already recording a meeting — stop that one first.');
  const settings = await getSettings();
  let platform = 'Unknown', tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (UNRECORDABLE.test(tab.url || '')) throw new Error("This page can't be recorded — switch to your meeting tab, then press Start.");
    platform = derivePlatform(tab.url);
    tabTitle = (tab.title || '').trim();
  } catch (e) { if (/can't be recorded/.test(e.message)) throw e; }

  const meetingId = new Date().toISOString().replace(/[:.]/g, '-');
  const videoEnabled = settings.videoEnabled;
  const startedAt = new Date();
  const title = tabTitle ? tabTitle.slice(0, 80) : platform + ' meeting';

  await ensureOffscreen();
  let streamId;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
  catch (e) { throw new Error("Chrome refused to capture this tab (" + e.message + "). Click into the meeting tab once, then press Start."); }

  const videoOptions = {
    resolution: settings.videoResolution || '1080p',
    fps: settings.videoFps || 30,
    codec: settings.videoCodec || 'vp9',
  };
  const recordMode = settings.recordMode || 'call';

  chrome.runtime.sendMessage({
    action: 'START_RECORDING',
    target: 'offscreen',
    data: { streamId, videoEnabled, meetingId, recordMode, videoOptions }
  });

  recordingState = { isRecording: true, tabId, meetingId, startTime: Date.now(), videoEnabled, platform };
  chrome.storage.local.set({ isRecording: true, meetingId, tabId, startTime: recordingState.startTime, videoEnabled, platform });
  await clearCaptions(meetingId);
  await upsertMeeting(meetingId, { date: startedAt.toISOString(), title, platform, folder: folderName(startedAt, platform), state: 'recording', videoEnabled, notes: '', error: null, warnings: [] });

  chrome.action.setBadgeText({ text: 'REC' }); chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.tabs.sendMessage(tabId, { action: 'SHOW_UI', meetingId }).catch(() => {});

  return { success: true, meetingId, hasKey: !!providerKey(settings), provider: settings.provider };
}

async function stopCapture() {
  const id = recordingState.meetingId;
  if (!id) return;
  if (recordingState.pausedAt) { recordingState.startTime += Date.now() - recordingState.pausedAt; recordingState.pausedAt = null; }
  const settings = await getSettings();
  const cues = await readCaptionCues(id);
  const captions = cues.length ? buildTxtTranscript(cues) : await readCaptions(id);
  const meta = await buildMeta(id);

  if (cues.length > 0) {
    const vttContent = buildVttContent(cues);
    const txtContent = buildTxtTranscript(cues);
    saveFile(id, 'vtt', new Blob([vttContent], { type: 'text/vtt' }));
    saveFile(id, 'transcript', new Blob([txtContent], { type: 'text/plain' }));
  }

  chrome.runtime.sendMessage({ action: 'STOP_RECORDING', target: 'offscreen', data: { captions, settings, meta } }).catch(() => {});

  if (recordingState.tabId) chrome.tabs.sendMessage(recordingState.tabId, { action: 'HIDE_UI' }).catch(() => {});

  await upsertMeeting(id, { state: 'processing', duration: meta.duration, captions: captions || '' });
  recordingState = { isRecording: false, tabId: null, meetingId: null, startTime: null, videoEnabled: true, platform: 'Unknown', pausedAt: null };
  chrome.storage.local.set({ isRecording: false, meetingId: null, tabId: null, startTime: null });

  chrome.action.setBadgeText({ text: '' });
  return { success: true };
}

async function pauseCapture(pause) {
  if (!recordingState.isRecording) return;
  if (pause && !recordingState.pausedAt) {
    recordingState.pausedAt = Date.now();
    chrome.action.setBadgeText({ text: 'PAUSE' }); chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else if (!pause && recordingState.pausedAt) {
    recordingState.startTime += Date.now() - recordingState.pausedAt;
    recordingState.pausedAt = null;
    chrome.action.setBadgeText({ text: 'REC' }); chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
  chrome.runtime.sendMessage({ action: pause ? 'PAUSE_RECORDING' : 'RESUME_RECORDING', target: 'offscreen' }).catch(() => {});
}

// --------------------------------------------------------------------------- message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_CAPTURE') {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    startCapture(tabId).then((res) => sendResponse(res)).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'STOP_CAPTURE') {
    stopCapture().then((res) => sendResponse(res)).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'PAUSE_CAPTURE') { pauseCapture(true); sendResponse({ success: true }); return; }
  if (message.action === 'RESUME_CAPTURE') { pauseCapture(false); sendResponse({ success: true }); return; }

  if (message.action === 'KEEPALIVE') {
    sendResponse({ alive: true, timestamp: Date.now() });
    return true;
  }

  if (message.action === 'APPEND_CAPTION') {
    if (recordingState.meetingId) appendCaption(recordingState.meetingId, message.cue || message.line);
    return;
  }
  if (message.action === 'SAVE_FILE') {
    saveFile(message.meetingId, message.kind, message.blob);
    return;
  }
  if (message.action === 'NOTES_READY') {
    if (message.notes) {
      saveFile(message.meetingId, 'notes', new Blob([message.notes], { type: 'text/markdown' }));
    }
    upsertMeeting(message.meetingId, { state: 'done', notes: message.notes, model: message.model, provider: message.provider, warnings: message.warnings || [] }).then(async () => {
      chrome.notifications.create('notes-ready-' + message.meetingId, {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'Ghost Recorder — Notes Ready',
        message: 'AI notes are ready! Click to open your meeting dashboard.',
      });
    });
    return;
  }
  if (message.action === 'NOTES_ERROR') {
    upsertMeeting(message.meetingId, { state: 'error', error: message.error, warnings: message.warnings || [] });
    chrome.notifications.create('notes-err-' + message.meetingId, {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'Ghost Recorder — Note Error',
      message: 'Failed to generate notes: ' + message.error,
    });
    return;
  }
  if (message.action === 'RETRY_NOTES') {
    (async () => {
      const settings = await getSettings();
      if (message.template) settings.template = message.template;
      const m = await getMeeting(message.meetingId);
      await upsertMeeting(message.meetingId, { state: 'processing', error: null });
      chrome.runtime.sendMessage({
        action: 'RETRY', target: 'offscreen',
        data: { meetingId: message.meetingId, settings, meta: { date: m && m.date, platform: (m && m.platform) || 'Unknown', duration: (m && m.duration) || 'Unknown', title: m && m.title } }
      }).catch(() => {});
    })();
    return;
  }
  if (message.action === 'DELETE_MEETING') {
    deleteMeeting(message.meetingId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'RENAME_MEETING') {
    upsertMeeting(message.meetingId, { title: message.title })
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'SET_THUMB') {
    upsertMeeting(message.meetingId, { thumb: message.thumb }).then(() => sendResponse({ success: true })).catch(() => {});
    return true;
  }
  if (message.action === 'EMAIL_NOTES') {
    (async () => {
      const settings = await getSettings();
      if (!settings.email || !settings.email.trim()) {
        sendResponse({ error: 'no-email' });
        return;
      }
      const m = await getMeeting(message.meetingId);
      if (!m || !m.notes) {
        sendResponse({ error: 'no-notes' });
        return;
      }
      const subject = encodeURIComponent(`Meeting Notes: ${m.title || 'Meeting'}`);
      const body = encodeURIComponent(m.notes);
      const to = encodeURIComponent(settings.email.trim());
      const url = `mailto:${to}?subject=${subject}&body=${body}`;
      chrome.tabs.create({ url });
      sendResponse({ success: true });
    })();
    return true;
  }
  if (message.action === 'TAB_ENDED') {
    if (recordingState.isRecording && recordingState.meetingId === message.meetingId) stopCapture();
    return;
  }
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});
