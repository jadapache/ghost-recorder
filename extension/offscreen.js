// Ghost Recorder — Offscreen Recorder (serverless, multi-provider)
//
// Multi-Track Audio & High-Res Video Graph:
// Call Mode:
//   tab audio ─┬─► tabGain ─► merger(Channel 0: Remote) ─► recDest ─► MediaRecorder(s)
//              └─► monitorEl ─► Playout (you keep HEARING the call, once)
//   mic audio ───► micGain ─► merger(Channel 1: You)   ─► recDest
// System Only Mode:
//   tab audio ───► tabGain ─► recDest ─► MediaRecorder(s)

let ctx = null, tabStream = null, micStream = null, recDest = null, mergerNode = null, micConnected = false, monitorEl = null;
let audioRecorder = null, videoRecorder = null, audioChunks = [], videoChunks = [];
let meetingId = null, stopping = false, recStartMs = 0;
let levelTimer = null, tabLevel = null, micLevel = null, tabHadAudio = false, micHadAudio = false, tabHadAudioTrack = false;
let silenceWarned = false, levelTicks = 0, persistTimer = null, samplerTimer = null, keepAliveTimer = null;
let tabPeak = 0, micPeak = 0, tabPeakAll = 0, micPeakAll = 0;
let pausedAt = 0, totalPausedMs = 0;
let monitorFailures = 0, monitorViaCtx = false;
let micGainNode = null, micMutedByUser = false;
let currentRecordMode = 'call';

function log(msg) { console.log('[offscreen]', msg); chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => {}); }

const IDB_NAME = 'ghost', IDB_STORE = 'pending';
function idb() { return new Promise((res, rej) => { const r = indexedDB.open(IDB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE, { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(id) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readonly'); const rq = tx.objectStore(IDB_STORE).get(id); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbDel(id) { const db = await idb(); return new Promise((res) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete(id); tx.oncomplete = res; tx.onerror = res; }); }
async function idbAll() { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readonly'); const rq = tx.objectStore(IDB_STORE).getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); }); }
async function pruneLibrary() {
  try {
    const ids = (await idbAll()).map((r) => r.id).filter((i) => !String(i).startsWith('live-')).sort().reverse();
    for (const id of ids.slice(12)) await idbDel(id);
  } catch (e) { log('prune failed: ' + e.message); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  if (message.action === 'PING') { sendResponse({ ready: true }); return; }
  if (message.action === 'START_RECORDING') {
    startRecording(message.data.streamId, message.data.videoEnabled, message.data.meetingId, message.data.recordMode, message.data.videoOptions, message.data.audioOptions);
  }
  else if (message.action === 'STOP_RECORDING') stopRecording(message.data || {});
  else if (message.action === 'PAUSE_RECORDING') pauseRecording(true);
  else if (message.action === 'RESUME_RECORDING') pauseRecording(false);
  else if (message.action === 'MIC_READY') connectMic('mic-ready');
  else if (message.action === 'MIC_MUTE') setMicMuted(!!(message.data && message.data.muted), (message.data && message.data.source) || 'user');
  else if (message.action === 'RETRY') retry(message.data || {});
  else if (message.action === 'RECOVER') recoverInterrupted();
});

function setMicMuted(muted, source) {
  micMutedByUser = muted;
  if (micGainNode) {
    try { micGainNode.gain.value = muted ? 0 : 1; } catch (e) { /* */ }
  }
  log('mic ' + (muted ? 'MUTED' : 'unmuted') + ' in recording (' + source + ')');
}

async function recoverInterrupted() {
  try {
    const all = await idbAll();
    for (const rec of all) {
      const rid = String(rec.id);
      if (!rid.startsWith('live-')) continue;
      const mid = rid.slice(5);
      if (mid === meetingId) continue;
      log('recovering interrupted recording ' + mid);
      await new Promise((res) => chrome.runtime.sendMessage({ action: 'RECOVERED', meetingId: mid, hasVideo: !!rec.video }, () => res()));
      if (rec.audio) { const d = await measureDurationMs(rec.audio, 0); if (d > 0) rec.audio = await fixWebmDuration(rec.audio, d); }
      if (rec.video) { const d = await measureDurationMs(rec.video, 0); if (d > 0) rec.video = await fixWebmDuration(rec.video, d); }
      if (rec.audio) saveBlob(mid, 'audio', rec.audio);
      if (rec.video) saveBlob(mid, 'video', rec.video);
      await idbPut({ id: mid, audio: rec.audio, video: rec.video || null, captions: rec.captions || '', settings: rec.settings || null, meta: rec.meta || {} });
      await idbDel(rid);
    }
  } catch (e) { log('recover failed: ' + e.message); }
}

function levelChecker(node) {
  const an = ctx.createAnalyser(); an.fftSize = 512; node.connect(an);
  const data = new Uint8Array(an.fftSize);
  return () => { an.getByteTimeDomainData(data); let s = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; } return Math.sqrt(s / data.length); };
}

async function connectMic(why) {
  if (micConnected || !ctx || !recDest || currentRecordMode === 'system_only') return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    if (ctx.state === 'suspended') await ctx.resume();
    const micNode = ctx.createMediaStreamSource(micStream);
    const micGain = ctx.createGain(); micGain.gain.value = micMutedByUser ? 0 : 1;
    micGainNode = micGain;

    if (mergerNode) {
      micNode.connect(micGain).connect(mergerNode, 0, 1);
    } else {
      micNode.connect(micGain).connect(recDest);
    }

    micLevel = levelChecker(micNode);
    micConnected = true;
    chrome.runtime.sendMessage({ action: 'MIC_STATUS', connected: true }).catch(() => {});
    log(`microphone mixed into Channel 1 (${why})`);
  } catch (err) { log(`microphone not available (${why}): ${err.message}`); }
}

function pauseRecording(pause) {
  try {
    for (const r of [audioRecorder, videoRecorder]) {
      if (!r) continue;
      if (pause && r.state === 'recording') r.pause();
      else if (!pause && r.state === 'paused') r.resume();
    }
    if (pause) pausedAt = Date.now();
    else if (pausedAt) { totalPausedMs += Date.now() - pausedAt; pausedAt = 0; }
    log(pause ? 'recording paused' : 'recording resumed');
  } catch (e) { log('pause/resume failed: ' + e.message); }
}

function sendAudioStatus(ok, text) {
  chrome.runtime.sendMessage({ action: 'AUDIO_STATUS', ok, text }).catch(() => {});
}

function measureDurationMs(blob, fallbackMs) {
  return new Promise((resolve) => {
    let el, url, timer;
    const done = (ms) => {
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      if (el) { el.onerror = el.onloadedmetadata = el.ondurationchange = null; el.src = ''; el.remove(); }
      resolve(ms);
    };
    try {
      url = URL.createObjectURL(blob);
      el = document.createElement('video');
      el.preload = 'metadata'; el.muted = true;
      timer = setTimeout(() => done(fallbackMs), 10000);
      el.onerror = () => done(fallbackMs);
      el.onloadedmetadata = () => {
        if (isFinite(el.duration) && el.duration > 0) { done(el.duration * 1000); return; }
        el.ondurationchange = () => { if (isFinite(el.duration) && el.duration > 0) done(el.duration * 1000); };
        el.currentTime = 1e8;
      };
      el.src = url;
    } catch (e) { done(fallbackMs); }
  });
}

async function fixWebmDuration(blob, durationMs) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const vintLen = (b) => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return -1; };
    function readElem(pos) {
      const idLen = vintLen(buf[pos]);
      if (idLen < 1 || pos + idLen >= buf.length) return null;
      let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
      const sp = pos + idLen, sizeLen = vintLen(buf[sp]);
      if (sizeLen < 1) return null;
      let size = buf[sp] & (0xff >> sizeLen), unknown = size === (0xff >> sizeLen);
      for (let i = 1; i < sizeLen; i++) { size = size * 256 + buf[sp + i]; if (buf[sp + i] !== 0xff) unknown = false; }
      return { id, size, sizeLen, hdrLen: idLen + sizeLen, dataPos: sp + sizeLen, pos, unknown };
    }
    let pos = 0, seg = null;
    while (pos < buf.length) { const e = readElem(pos); if (!e) return blob; if (e.id === 0x18538067) { seg = e; break; } pos = e.dataPos + e.size; }
    if (!seg) return blob;
    pos = seg.dataPos; let info = null;
    while (pos < buf.length) {
      const e = readElem(pos); if (!e) return blob;
      if (e.id === 0x1549A966) { info = e; break; }
      if (e.id === 0x1F43B675 || e.unknown) return blob;
      pos = e.dataPos + e.size;
    }
    if (!info || info.unknown) return blob;
    let scale = 1000000, dur = null; pos = info.dataPos;
    while (pos < info.dataPos + info.size) {
      const e = readElem(pos); if (!e) break;
      if (e.id === 0x2AD7B1) { let v = 0; for (let i = 0; i < e.size; i++) v = v * 256 + buf[e.dataPos + i]; if (v) scale = v; }
      if (e.id === 0x4489) dur = e;
      pos = e.dataPos + e.size;
    }
    const durVal = durationMs * 1e6 / scale;
    if (dur && (dur.size === 8 || dur.size === 4)) {
      const dv = new DataView(buf.buffer, dur.dataPos, dur.size);
      if (dur.size === 8) dv.setFloat64(0, durVal); else dv.setFloat32(0, durVal);
      return new Blob([buf], { type: blob.type });
    }
    if (dur) return blob;
    const durBytes = new Uint8Array(11);
    durBytes[0] = 0x44; durBytes[1] = 0x89; durBytes[2] = 0x88;
    new DataView(durBytes.buffer).setFloat64(3, durVal);
    const newInfoSize = info.size + durBytes.length;
    const infoHdr = new Uint8Array(4 + 8);
    infoHdr.set([0x15, 0x49, 0xA9, 0x66, 0x01]);
    for (let i = 0; i < 7; i++) infoHdr[5 + i] = (newInfoSize / Math.pow(256, 6 - i)) & 0xff;
    const prefix = buf.slice(0, info.pos);
    const delta = (infoHdr.length + durBytes.length + info.size) - (info.hdrLen + info.size);
    if (!seg.unknown) {
      let s = seg.size + delta;
      const segSizePos = seg.pos + (seg.hdrLen - seg.sizeLen);
      if (seg.sizeLen !== 8) return blob;
      prefix[segSizePos] = 0x01;
      for (let i = 0; i < 7; i++) prefix[segSizePos + 1 + i] = (s / Math.pow(256, 6 - i)) & 0xff;
    }
    return new Blob([prefix, infoHdr, durBytes, buf.slice(info.dataPos)], { type: blob.type });
  } catch (e) { log('webm duration patch skipped: ' + e.message); return blob; }
}

function onTabEnded() {
  if (stopping) return;
  log('captured tab ended (closed/navigated) — auto-stopping');
  chrome.runtime.sendMessage({ action: 'TAB_ENDED', meetingId }).catch(() => {});
}

function teardownGraph() {
  try { if (samplerTimer) clearInterval(samplerTimer); } catch (e) {}
  try { if (levelTimer) clearInterval(levelTimer); } catch (e) {}
  try { if (persistTimer) clearInterval(persistTimer); } catch (e) {}
  try { if (keepAliveTimer) clearInterval(keepAliveTimer); } catch (e) {}
  try { if (monitorEl) { monitorEl.pause(); monitorEl.srcObject = null; monitorEl.remove(); monitorEl = null; } } catch (e) {}
  try { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } } catch (e) {}
  try { if (tabStream) { tabStream.getTracks().forEach((t) => t.stop()); tabStream = null; } } catch (e) {}
  try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e) {}
  ctx = recDest = mergerNode = micGainNode = null;
  micConnected = false;
}

async function startRecording(streamId, videoEnabled, id, recordMode, videoOptions, audioOptions) {
  meetingId = id; stopping = false; audioChunks = []; videoChunks = [];
  currentRecordMode = recordMode || 'call';
  tabHadAudio = micHadAudio = tabHadAudioTrack = false; silenceWarned = false; levelTicks = 0;
  tabPeak = 0; micPeak = 0; tabPeakAll = 0; micPeakAll = 0;
  recStartMs = Date.now(); pausedAt = 0; totalPausedMs = 0;

  vOpts = Object.assign({ resolution: '1080p', fps: 30, codec: 'vp9', bitrate: 'auto' }, videoOptions || {});
  const resMap = {
    '4k': { w: 3840, h: 2160, b: 14000000, fps: 30 },
    '1440p': { w: 2560, h: 1440, b: 8000000, fps: 30 },
    '1080p': { w: 1920, h: 1080, b: 4500000, fps: 30 },
    '720p': { w: 1280, h: 720, b: 2500000, fps: 30 },
    '720p_low': { w: 1280, h: 720, b: 1200000, fps: 10 }
  };
  const targetSpec = resMap[vOpts.resolution] || resMap['1080p'];
  const targetFps = parseInt(vOpts.fps, 10) || targetSpec.fps;
  const targetBitrate = targetSpec.b;

  log(`starting recording (mode=${currentRecordMode}, video=${videoEnabled}, spec=${targetSpec.w}x${targetSpec.h}@${targetFps}, id=${id})`);

  try {
    const constraints = { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, googDisableLocalEcho: true } } };
    if (videoEnabled) {
      constraints.video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: targetSpec.w, maxHeight: targetSpec.h, maxFrameRate: targetFps } };
    }
    tabStream = await navigator.mediaDevices.getUserMedia(constraints);

    const tabAudio = tabStream.getAudioTracks();
    tabHadAudioTrack = tabAudio.length > 0;
    log(`captured tracks — video:${tabStream.getVideoTracks().length} audio:${tabAudio.length}`);
    tabStream.getTracks().forEach((t) => { t.onended = onTabEnded; });

    ctx = new AudioContext({ latencyHint: 'playback' });
    if (ctx.state === 'suspended') await ctx.resume();
    ctx.onstatechange = () => { if (ctx && ctx.state === 'suspended' && !stopping) ctx.resume().catch(() => {}); };

    if (currentRecordMode === 'call') {
      recDest = ctx.createMediaStreamDestination();
      recDest.channelCount = 2;
      mergerNode = ctx.createChannelMerger(2);
      mergerNode.connect(recDest);
    } else {
      recDest = ctx.createMediaStreamDestination();
      mergerNode = null;
    }

    let startMonitor = () => {};
    if (tabAudio.length) {
      const tabNode = ctx.createMediaStreamSource(new MediaStream([tabAudio[0]]));
      const recGain = ctx.createGain(); recGain.gain.value = 1.0;

      if (mergerNode) {
        tabNode.connect(recGain).connect(mergerNode, 0, 0); // Channel 0 (Left) = System/Call Audio
      } else {
        tabNode.connect(recGain).connect(recDest);
      }

      monitorEl = new Audio();
      monitorEl.srcObject = new MediaStream([tabAudio[0]]);
      monitorFailures = 0; monitorViaCtx = false;
      startMonitor = () => {
        if (!monitorEl || stopping || monitorViaCtx) return;
        monitorEl.play().then(() => { monitorFailures = 0; }).catch((e) => {
          monitorFailures++;
          log('monitor play failed (' + monitorFailures + '): ' + e.message);
          if (monitorFailures >= 3) {
            monitorViaCtx = true;
            try { tabNode.connect(ctx.destination); log('monitor fallback: WebAudio playout engaged'); }
            catch (e2) { log('monitor fallback failed: ' + e2.message); }
          } else setTimeout(startMonitor, 2000);
        });
      };
      startMonitor();
      tabLevel = levelChecker(tabNode);
      tabAudio[0].onmute = () => log('tab audio track muted (natural silence)');
      tabAudio[0].onunmute = () => log('tab audio track unmuted');
    } else { log('WARNING: no tab audio track'); }

    samplerTimer = setInterval(() => {
      if (tabLevel) { const v = tabLevel(); tabPeak = Math.max(tabPeak, v); tabPeakAll = Math.max(tabPeakAll, v); }
      if (micLevel) { const v = micLevel(); micPeak = Math.max(micPeak, v); micPeakAll = Math.max(micPeakAll, v); }
    }, 300);

    levelTimer = setInterval(() => {
      if (ctx && ctx.state !== 'running' && !stopping) ctx.resume().catch(() => {});
      if (monitorEl && !monitorViaCtx && monitorEl.paused && !stopping) startMonitor();
      levelTicks++;
      if (tabPeak > 0.008) { if (!tabHadAudio || silenceWarned) { silenceWarned = false; sendAudioStatus(true, ''); } tabHadAudio = true; }
      if (micPeak > 0.008) micHadAudio = true;
      if (levelTicks % 10 === 0) log(`audio levels — tabPeak=${tabPeak.toFixed(4)} micPeak=${micPeak.toFixed(4)}`);
      tabPeak = 0; micPeak = 0;
      if (!tabHadAudio && levelTicks === 7 && !silenceWarned) { silenceWarned = true; sendAudioStatus(false, 'No meeting audio detected yet — unmute the tab / check call sound.'); }
    }, 2000);

    const amime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    audioRecorder = new MediaRecorder(recDest.stream, { mimeType: amime, audioBitsPerSecond: 128000 });
    audioRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    audioRecorder.start(5000);

    if (videoEnabled && tabStream.getVideoTracks().length) {
      let vmime = 'video/webm';
      if (vOpts.codec === 'vp9' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) vmime = 'video/webm;codecs=vp9,opus';
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) vmime = 'video/webm;codecs=vp8,opus';

      const recordStream = new MediaStream([tabStream.getVideoTracks()[0], ...recDest.stream.getAudioTracks()]);
      videoRecorder = new MediaRecorder(recordStream, { mimeType: vmime, videoBitsPerSecond: targetBitrate, audioBitsPerSecond: 128000 });
      videoRecorder.ondataavailable = (e) => { if (e.data && e.data.size) videoChunks.push(e.data); };
      videoRecorder.start(5000);
    }
    log('recording started successfully');

    persistTimer = setInterval(() => {
      if (stopping || !meetingId) return;
      const snap = { id: 'live-' + meetingId, updated: Date.now(), meta: { date: new Date(recStartMs).toISOString() } };
      if (audioChunks.length) snap.audio = new Blob(audioChunks, { type: 'audio/webm' });
      if (videoChunks.length) snap.video = new Blob(videoChunks, { type: 'video/webm' });
      if (snap.audio) idbPut(snap).catch((e) => log('live snapshot failed: ' + e.message));
    }, 20000);

    keepAliveTimer = setInterval(() => {
      if (stopping || !meetingId) return;
      chrome.runtime.sendMessage({ action: 'KEEPALIVE', meetingId }).catch(() => {});
    }, 20000);

    if (currentRecordMode === 'call') {
      connectMic('eager').then(() => {
        if (!micConnected) chrome.runtime.sendMessage({ action: 'MIC_STATUS', connected: false }).catch(() => {});
      });
    }
  } catch (err) {
    log(`recording failed to start: ${err.message}`);
    try { teardownGraph(); } catch (e) {}
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'Recording failed to start: ' + err.message }).catch(() => {});
  }
}

function saveBlob(id, kind, blob) {
  chrome.runtime.sendMessage({ action: 'SAVE_FILE', meetingId: id, kind, blob }).catch(() => {});
}

function db(v) { return v ? (20 * Math.log10(v)).toFixed(1) + ' dBFS' : '-inf dBFS'; }
function audioWarnings() {
  const w = [];
  if (!tabHadAudioTrack) w.push('No audio track was captured from the meeting tab.');
  else if (!tabHadAudio) w.push('The meeting tab produced no audio — was the call silent / was your computer output muted?');
  if (currentRecordMode === 'call') {
    if (!micConnected) w.push('Microphone was NOT connected — your voice was not recorded. Enable mic in Settings for 2-sided calls.');
    else if (micMutedByUser) w.push('Your mic was muted for part of this recording.');
    else if (!micHadAudio) w.push('Your microphone stayed silent — check input device settings.');
  }
  return w;
}

async function transcribeAndReport(id, audioBlob, captions, ctxData, extraWarnings) {
  log('generating notes with ' + (ctxData.settings && ctxData.settings.provider) + '…');
  try {
    const res = await self.GhostProviders.run(audioBlob, captions || '', ctxData.settings, ctxData.meta || {});
    chrome.runtime.sendMessage({ action: 'NOTES_READY', meetingId: id, notes: res.notes, model: res.model, provider: res.provider, warnings: (extraWarnings || []).concat(res.warnings || []) }).catch(() => {});
    log('notes ready');
  } catch (err) {
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: err.message, warnings: extraWarnings || [] }).catch(() => {});
    log('notes failed: ' + err.message);
  }
}

async function stopRecording(opts) {
  if (stopping) return; stopping = true;
  const id = meetingId;
  log('stopping recording');
  const waits = [];
  for (const r of [audioRecorder, videoRecorder]) {
    if (r && r.state !== 'inactive') { waits.push(new Promise((res) => { r.onstop = res; })); r.stop(); }
  }
  await Promise.all(waits);

  if (pausedAt) { totalPausedMs += Date.now() - pausedAt; pausedAt = 0; }
  const durationMs = Math.max(0, Date.now() - recStartMs - totalPausedMs);
  let audioBlob = audioChunks.length ? new Blob(audioChunks, { type: 'audio/webm' }) : null;
  let videoBlob = videoChunks.length ? new Blob(videoChunks, { type: 'video/webm' }) : null;
  audioChunks = []; videoChunks = [];
  const warnings = audioWarnings();

  if (audioBlob) audioBlob = await fixWebmDuration(audioBlob, await measureDurationMs(audioBlob, durationMs));
  if (videoBlob) videoBlob = await fixWebmDuration(videoBlob, await measureDurationMs(videoBlob, durationMs));
  if (videoBlob) saveBlob(id, 'video', videoBlob);
  if (audioBlob) saveBlob(id, 'audio', audioBlob);

  teardownGraph();
  meetingId = null;

  if (!audioBlob) {
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'No audio captured.', warnings }).catch(() => {});
    return;
  }
  const ctxData = { settings: opts.settings, meta: opts.meta || {} };
  try { await idbPut({ id, audio: audioBlob, video: videoBlob || null, captions: opts.captions || '', settings: opts.settings, meta: opts.meta || {} }); } catch (e) { log('idb put failed: ' + e.message); }
  await idbDel('live-' + id);
  pruneLibrary();
  await transcribeAndReport(id, audioBlob, opts.captions || '', ctxData, warnings);
}

async function retry(opts) {
  const id = opts.meetingId;
  try {
    const rec = await idbGet(id);
    if (!rec || !rec.audio) { chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'Audio no longer available to retry — please re-record.' }).catch(() => {}); return; }
    const settings = opts.settings || rec.settings;
    await transcribeAndReport(id, rec.audio, rec.captions || '', { settings, meta: opts.meta || rec.meta || {} }, []);
  } catch (err) { chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: err.message }).catch(() => {}); }
}
