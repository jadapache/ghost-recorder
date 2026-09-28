// Ghost Recorder — Content Script (runs on all sites)
// - injects audio-sink override + MAIN-world WebRTC hook
// - universally detects "in a call" and offers a dismissible Record suggestion
// - scrapes Google Meet captions (speaker names + timestamps)
// - shows user-only recording overlay (with auto-hide for clean video recordings)
(function () {
  'use strict';

  const PLATFORMS = { GOOGLE_MEET: 'google_meet', ZOOM: 'zoom', MS_TEAMS: 'ms_teams', UNKNOWN: 'unknown' };
  function detectPlatform() {
    const u = location.href;
    if (u.includes('meet.google.com')) return PLATFORMS.GOOGLE_MEET;
    if (u.includes('zoom.us')) return PLATFORMS.ZOOM;
    if (u.includes('teams.microsoft.com') || u.includes('teams.live.com') || u.includes('teams.cloud.microsoft')) return PLATFORMS.MS_TEAMS;
    return PLATFORMS.UNKNOWN;
  }
  const platform = detectPlatform();
  chrome.runtime.sendMessage({ action: 'PLATFORM_DETECTED', platform }).catch(() => {});

  // ---- mic permission iframe (grants mic to the extension origin) ----
  function injectMicIframe() {
    if (document.getElementById('ghost-mic-iframe')) return;
    const f = document.createElement('iframe');
    f.id = 'ghost-mic-iframe'; f.src = chrome.runtime.getURL('mic-permission.html'); f.allow = 'microphone';
    f.style.cssText = 'position:fixed;top:-100px;width:1px;height:1px;opacity:0;border:none;';
    (document.body || document.documentElement).appendChild(f);
  }
  let webrtcActive = false;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'vmh-webrtc') webrtcActive = !!e.data.active;
    if (e.data.type === 'MIC_PERMISSION_GRANTED') chrome.runtime.sendMessage({ action: 'MIC_READY' }).catch(() => {});
  });

  // ---- universal meeting detection ----
  const MEETING_HOSTS = [/(^|\.)meet\.google\.com$/, /(^|\.)zoom\.us$/, /(^|\.)teams\.(microsoft|live)\.com$/, /(^|\.)webex\.com$/, /(^|\.)whereby\.com$/, /(^|\.)zoho\.com$/, /(^|\.)around\.co$/, /(^|\.)jit\.si$/, /^8x8\.vc$/, /(^|\.)bluejeans\.com$/, /(^|\.)gotomeeting\.com$/, /(^|\.)goto\.com$/, /(^|\.)gather\.town$/, /(^|\.)chime\.aws$/, /(^|\.)daily\.co$/, /(^|\.)dialpad\.com$/, /(^|\.)ringcentral\.com$/, /^discord\.com$/, /^app\.slack\.com$/];
  const STRONG_PATH = /\/(j|wc|s|meetup-join|meet|webappng|wbxmjs|huddle|call|room)\b|\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
  const LEAVE_RE = /leave|hang ?up|end (call|meeting)|disconnect|leave huddle/i;

  function hasLiveVideo() {
    for (const v of document.querySelectorAll('video')) {
      const s = v.srcObject;
      if (s && typeof s.getTracks === 'function' && s.getTracks().some((t) => t.readyState === 'live')) return true;
    }
    return false;
  }
  function hasLeaveControl() {
    for (const el of document.querySelectorAll('button,[role="button"],[aria-label]')) {
      const t = (el.getAttribute('aria-label') || el.textContent || '').slice(0, 40);
      if (LEAVE_RE.test(t)) return true;
    }
    return false;
  }
  function detectMeeting() {
    const urlHit = MEETING_HOSTS.some((re) => re.test(location.host));
    const strongUrl = urlHit && STRONG_PATH.test(location.pathname);
    const liveVideo = hasLiveVideo();
    const leave = hasLeaveControl();
    return (webrtcActive && (liveVideo || leave)) || (liveVideo && leave) || (strongUrl && (liveVideo || webrtcActive || leave));
  }

  // ---- auto-suggest toast ----
  let suggestShown = false, dismissedFor = '';
  const roomKey = () => location.host + location.pathname;
  function showSuggest() {
    if (suggestShown || dismissedFor === roomKey() || document.getElementById('ghost-suggest')) return;
    suggestShown = true;
    const host = document.createElement('div'); host.id = 'ghost-suggest';
    host.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:2147483647;';
    document.body.appendChild(host);
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>
      .t{display:flex;align-items:center;gap:12px;background:rgba(15,23,42,.96);color:#fff;font-family:'Segoe UI',sans-serif;
        padding:12px 16px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12);font-size:14px;}
      .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:p 1.6s infinite;}
      button{border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:13px;}
      .rec{background:#2563eb;color:#fff;} .no{background:transparent;color:#94a3b8;}
      @keyframes p{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}</style>
      <div class="t"><span class="dot"></span><span>Looks like you're in a meeting — record it?</span>
        <button class="rec" id="r">Record</button><button class="no" id="n">Not now</button></div>`;
    sh.getElementById('r').onclick = () => {
      host.remove(); suggestShown = false;
      injectMicIframe();
      chrome.runtime.sendMessage({ action: 'START_CAPTURE' }, (res) => {
        if (!res || !res.success) toast('Click the Ghost Recorder toolbar icon to start recording.');
        else if (!res.hasKey && res.provider !== 'local' && res.provider !== 'chrome_ai') toast('Recording — but add your ' + (res.provider || 'AI') + ' API key in Settings to get notes.');
      });
    };
    sh.getElementById('n').onclick = () => {
      host.remove(); suggestShown = false; dismissedFor = roomKey();
      chrome.storage.local.get('gr_dismiss', ({ gr_dismiss }) => { const m = gr_dismiss || {}; m[location.host] = Date.now(); chrome.storage.local.set({ gr_dismiss: m }); });
    };
  }
  function toast(msg) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1e293b;color:#fff;padding:12px 18px;border-radius:10px;font-family:Segoe UI,sans-serif;font-size:13px;box-shadow:0 10px 24px rgba(0,0,0,.5);';
    d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 6000);
  }

  let detectTries = 0, detectTimer = null;
  function watchForMeeting() {
    chrome.storage.local.get(['settings', 'isRecording', 'gr_dismiss'], ({ settings, isRecording, gr_dismiss }) => {
      if (settings && settings.autoSuggest === false) return;
      if (isRecording) return;
      const d = (gr_dismiss || {})[location.host];
      if (d && (Date.now() - d) < 8 * 3600 * 1000) return;
      const tick = () => {
        if (detectMeeting()) { showSuggest(); return; }
        if (detectTries++ < 40) detectTimer = setTimeout(tick, 2500);
      };
      tick();
    });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') watchForMeeting();
  else window.addEventListener('DOMContentLoaded', watchForMeeting);

  // ---- recording overlay (Shadow DOM) ----
  let shadow = null, panel = null, transcriptBox = null, hostEl = null;
  const overlayLines = [];
  function createUI() {
    if (document.getElementById('ghost-recorder-ui')) return;
    hostEl = document.createElement('div'); hostEl.id = 'ghost-recorder-ui';
    hostEl.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    document.body.appendChild(hostEl);
    shadow = hostEl.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .panel{background:rgba(15,23,42,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:12px;color:#fff;font-family:'Segoe UI',sans-serif;width:320px;box-shadow:0 10px 25px rgba(0,0,0,.5);overflow:hidden;display:none;flex-direction:column;}
      .header{padding:10px 15px;background:rgba(255,255,255,.06);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:move;user-select:none;}
      .dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:p 2s infinite;}
      .time{color:#94a3b8;font-weight:600;font-size:12px;font-variant-numeric:tabular-nums;}
      .stop{margin-left:auto;background:#ef4444;color:#fff;border:0;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer;font-size:12px;}
      .pause{background:#334155;color:#fff;border:0;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer;font-size:12px;}
      .min{background:transparent;color:#94a3b8;border:0;font-weight:700;cursor:pointer;font-size:14px;padding:2px 6px;}
      .cls{background:transparent;color:#fca5a5;border:0;font-weight:700;cursor:pointer;font-size:14px;padding:2px 6px;}
      .bubble{display:none;width:30px;height:30px;border-radius:50%;background:rgba(15,23,42,.85);border:2px solid #ef4444;align-items:center;justify-content:center;cursor:pointer;font-size:15px;box-shadow:0 4px 14px rgba(0,0,0,.4);animation:p 2s infinite;}
      .content{padding:12px 15px;max-height:200px;overflow-y:auto;font-size:13px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;}
      .hint{font-size:11px;color:#64748b;padding:0 15px 10px;}
      @keyframes p{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 6px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}</style>
      <div class="bubble" id="bubble" title="Ghost Recorder — recording. Click to expand.">👻</div>
      <div class="panel" id="panel"><div class="header" id="hdr"><div class="dot" id="dot"></div>Ghost AI Notes<span class="time" id="tm">00:00</span><button class="pause" id="pause">⏸</button><button class="stop" id="stop">Stop</button><button class="min" id="min" title="Minimize">—</button><button class="cls" id="cls" title="Remove overlay from video recording">✕</button></div>
      <div class="content" id="t">Listening… AI transcribes full audio.</div><div class="hint" id="aud"></div><div class="hint" id="mic"></div><div class="hint" id="h"></div></div>`;
    panel = shadow.getElementById('panel'); transcriptBox = shadow.getElementById('t');
    shadow.getElementById('stop').onclick = () => {
      chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
      toast('✓ Recording saved — AI is writing your notes.');
    };
    let paused = false, pausedAtMs = 0;
    shadow.getElementById('pause').onclick = () => {
      paused = !paused;
      chrome.runtime.sendMessage({ action: paused ? 'PAUSE_CAPTURE' : 'RESUME_CAPTURE' });
      shadow.getElementById('pause').textContent = paused ? '▶' : '⏸';
      const d = shadow.getElementById('dot'); if (d) d.style.animationPlayState = paused ? 'paused' : 'running';
      if (paused) { pausedAtMs = Date.now(); stopOverlayTimer(); }
      else { startMs += Date.now() - pausedAtMs; startOverlayTimer(); }
      setHint(paused ? 'Paused — nothing is being recorded.' : '');
    };
    const bubble = shadow.getElementById('bubble');
    const setMin = (min) => {
      panel.style.display = min ? 'none' : 'flex';
      bubble.style.display = min ? 'flex' : 'none';
      chrome.storage.local.set({ gr_overlay_min: min });
    };
    shadow.getElementById('min').onclick = () => setMin(true);
    shadow.getElementById('cls').onclick = () => {
      if (hostEl) hostEl.style.display = 'none';
      toast('Overlay hidden for clean video. Control recording via toolbar icon.');
    };
    bubble.onclick = () => setMin(false);

    const hdr = shadow.getElementById('hdr');
    hdr.addEventListener('mousedown', (e) => {
      if (e.target.id === 'stop' || e.target.id === 'pause' || e.target.id === 'min' || e.target.id === 'cls') return;
      e.preventDefault();
      const r = hostEl.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        hostEl.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + 'px';
        hostEl.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
        hostEl.style.right = 'auto'; hostEl.style.bottom = 'auto';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  }
  let overlayTimer = null;
  function startOverlayTimer() {
    stopOverlayTimer();
    const el = shadow && shadow.getElementById('tm');
    if (!el) return;
    const tick = () => { const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000)); el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    tick(); overlayTimer = setInterval(tick, 1000);
  }
  function stopOverlayTimer() { if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; } }
  function setHint(t) { if (shadow) { const h = shadow.getElementById('h'); if (h) h.textContent = t; } }

  // ---- Robust Multilingual Caption Scraper (Meet / Teams / Zoom) ----
  let captionObserver = null, captionCheckInterval = null, startMs = 0;
  let activeTurn = null; // { speaker, text, startMs, endMs, lastUpdate }
  let turnDebounceTimer = null;
  const recentTexts = new Set(); // Prevent duplicates

  function fmtTs(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  }

  function escHtml(str) {
    return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function commitTurn() {
    if (!activeTurn) return;
    const { speaker, text, startMs: sMs, endMs: eMs } = activeTurn;
    activeTurn = null;
    const cleanText = (text || '').trim();
    if (cleanText.length < 2) return;

    const hash = `${speaker}:::${cleanText.toLowerCase()}`;
    if (recentTexts.has(hash)) return;
    recentTexts.add(hash);
    if (recentTexts.size > 300) {
      const first = recentTexts.values().next().value;
      recentTexts.delete(first);
    }

    const line = `[${fmtTs(sMs)}] ${speaker}: ${cleanText}`;
    const cue = { speaker, text: cleanText, startMs: sMs, endMs: eMs || (sMs + 2000), line };

    chrome.runtime.sendMessage({ action: 'APPEND_CAPTION', cue, line }).catch(() => {});

    if (transcriptBox) {
      if (transcriptBox.textContent.includes('Listening…') || transcriptBox.textContent.includes('Escuchando…')) {
        transcriptBox.textContent = '';
      }
      const p = document.createElement('div');
      p.style.cssText = 'margin-bottom: 5px; line-height: 1.4;';
      p.innerHTML = `<span style="color:#38bdf8;font-size:11px;font-family:monospace;">[${fmtTs(sMs)}]</span> <strong style="color:#a5b4fc;">${escHtml(speaker)}:</strong> <span>${escHtml(cleanText)}</span>`;
      transcriptBox.appendChild(p);
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    }
  }

  function handleCaptionChange(speaker, text) {
    const now = Math.max(0, Date.now() - startMs);
    let cleanText = (text || '').trim();
    if (!cleanText) return;
    if (speaker && cleanText.startsWith(speaker)) {
      cleanText = cleanText.slice(speaker.length).trim();
    }
    if (!cleanText) return;

    const spk = (speaker || 'Speaker').trim() || 'Speaker';

    if (activeTurn && activeTurn.speaker === spk) {
      if (cleanText.length >= activeTurn.text.length || !activeTurn.text.includes(cleanText)) {
        activeTurn.text = cleanText;
        activeTurn.endMs = now;
        activeTurn.lastUpdate = Date.now();
      }
    } else {
      commitTurn();
      activeTurn = {
        speaker: spk,
        text: cleanText,
        startMs: now,
        endMs: now + 1500,
        lastUpdate: Date.now()
      };
    }

    if (turnDebounceTimer) clearTimeout(turnDebounceTimer);
    turnDebounceTimer = setTimeout(() => {
      commitTurn();
    }, 2500);
  }

  function findCaptionContainer() {
    return document.querySelector('#live-transcription-subtitle') ||
      document.querySelector('div[jscontroller="D1tHje"]') ||
      document.querySelector('div[jsname="YSxPC"]') ||
      document.querySelector('div[class*="a4bIc"]') ||
      document.querySelector('div[class*="nMx2b"]') ||
      document.querySelector('[data-tid="closed-captions-renderer"]') ||
      document.querySelector('.closed-caption-container') ||
      document.querySelector('div[aria-live="polite"][class*="caption" i]') ||
      document.querySelector('div[aria-label*="caption" i], div[aria-label*="subtítulo" i]');
  }

  function parseContainer(container) {
    // 1. Google Meet standard blocks
    const meetRows = container.querySelectorAll('div[class*="nMx2b"], div[class*="T4LgNb"], div[class*="a4bIc"] > div, div[role="region"], div[jsname="YSxPC"]');
    if (meetRows.length > 0) {
      meetRows.forEach((row) => {
        const spEl = row.querySelector('[jsname="r4nke"], [class*="zs75bd"], [class*="jxFHg"], [class*="VbkSUe"], strong, [class*="speaker" i], [class*="name" i]');
        const txtEl = row.querySelector('[jsname="YSxPC"], [class*="iOzk7"], [class*="bh44bd"], span:last-child, p') || row;
        const speaker = (spEl ? spEl.textContent : '').trim() || 'Speaker';
        let text = (txtEl ? txtEl.textContent : row.textContent || '').trim();
        handleCaptionChange(speaker, text);
      });
      return;
    }

    // 2. Microsoft Teams blocks
    const teamsRows = container.querySelectorAll('[data-tid="closed-captions-message"], [class*="ui-chat__message"]');
    if (teamsRows.length > 0) {
      teamsRows.forEach((row) => {
        const spEl = row.querySelector('[data-tid="caption-speaker-name"], [class*="author" i], strong');
        const txtEl = row.querySelector('[data-tid="caption-text"], [class*="text" i]') || row;
        const speaker = (spEl ? spEl.textContent : '').trim() || 'Speaker';
        let text = (txtEl ? txtEl.textContent : row.textContent || '').trim();
        handleCaptionChange(speaker, text);
      });
      return;
    }

    // 3. Fallback generic blocks
    const genericBlocks = container.querySelectorAll('[class*="subtitle" i], [class*="caption" i], p, div');
    genericBlocks.forEach((b) => {
      const spEl = b.querySelector('strong, [class*="name" i], [class*="speaker" i]');
      const txtEl = b.querySelector('span:last-child, p') || b;
      const speaker = (spEl ? spEl.textContent : '').trim() || 'Speaker';
      let text = (txtEl ? txtEl.textContent : b.textContent || '').trim();
      if (text.length > 2) handleCaptionChange(speaker, text);
    });
  }

  function startCaptionScraper() {
    stopCaptionScraper();
    recentTexts.clear();
    activeTurn = null;

    let attachedContainer = null;
    const attachObserver = () => {
      const container = findCaptionContainer();
      if (container && container !== attachedContainer) {
        if (captionObserver) captionObserver.disconnect();
        attachedContainer = container;
        captionObserver = new MutationObserver(() => {
          try { parseContainer(container); } catch (e) { /* */ }
        });
        captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
        try { parseContainer(container); } catch (e) { /* */ }
      }
    };

    captionCheckInterval = setInterval(attachObserver, 2000);
    attachObserver();
  }

  function stopCaptionScraper() {
    commitTurn();
    if (turnDebounceTimer) { clearTimeout(turnDebounceTimer); turnDebounceTimer = null; }
    if (captionCheckInterval) { clearInterval(captionCheckInterval); captionCheckInterval = null; }
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
  }

  // ---- meeting-mute mirror ----
  let muteTimer = null, lastMuteState = null;
  function platformMuted() {
    try {
      const h = location.hostname;
      if (h.includes('meet.google.com')) {
        const b = document.querySelector('[data-is-muted]');
        if (b) return b.getAttribute('data-is-muted') === 'true';
      }
      if (h.includes('teams.microsoft.com') || h.includes('teams.live.com')) {
        const b = document.querySelector('#microphone-button, [data-tid="toggle-mute"]');
        if (b) { const al = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || ''); if (/unmute/i.test(al)) return true; if (/mute/i.test(al)) return false; }
      }
      if (h.includes('zoom.us')) {
        const b = document.querySelector('button[aria-label*="udio"], .join-audio-container button');
        if (b) { const al = b.getAttribute('aria-label') || ''; if (/unmute/i.test(al)) return true; if (/^mute/i.test(al)) return false; }
      }
      const g = document.querySelector('button[aria-label^="Unmute" i], button[aria-label^="Unmute microphone" i]');
      if (g) return true;
    } catch (e) { /* */ }
    return null;
  }
  function startMuteWatch() {
    stopMuteWatch(); lastMuteState = null;
    muteTimer = setInterval(() => {
      const m = platformMuted();
      if (m === null || m === lastMuteState) return;
      lastMuteState = m;
      chrome.runtime.sendMessage({ action: 'MEETING_MUTE', muted: m, source: 'meeting' }).catch(() => {});
      if (shadow) { const mi = shadow.getElementById('mic'); if (mi && m) { mi.textContent = '🔇 Muted in meeting — voice NOT recorded'; mi.style.color = '#fbbf24'; } else if (mi && !m) { mi.textContent = '🎤 Your voice: recording'; mi.style.color = '#34d399'; } }
    }, 1500);
  }
  function stopMuteWatch() { if (muteTimer) { clearInterval(muteTimer); muteTimer = null; } }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SHOW_UI') {
      chrome.storage.local.get('settings', ({ settings }) => {
        const s = settings || {};
        const mode = s.overlayMode || 'hide_on_video';
        const isVid = s.videoEnabled !== false;

        startMs = Date.now(); injectMicIframe(); startCaptionScraper(); startMuteWatch();

        if (mode === 'disabled' || (mode === 'hide_on_video' && isVid)) {
          toast('Recording meeting (video clean) — pause/stop anytime via Ghost Recorder toolbar icon.');
        } else {
          createUI(); startOverlayTimer();
          if (hostEl) hostEl.style.display = 'block';
          chrome.storage.local.get('gr_overlay_min', ({ gr_overlay_min }) => {
            if (!shadow) return;
            const b = shadow.getElementById('bubble');
            if ((mode === 'minimized' || gr_overlay_min) && b) { b.style.display = 'flex'; if (panel) panel.style.display = 'none'; }
            else if (panel) panel.style.display = 'flex';
          });
        }
        const sg = document.getElementById('ghost-suggest'); if (sg) sg.remove();
        sendResponse({ success: true });
      });
      return true;
    } else if (request.action === 'HIDE_UI') {
      stopCaptionScraper(); stopOverlayTimer(); stopMuteWatch();
      if (panel) panel.style.display = 'none';
      if (shadow) { const b = shadow.getElementById('bubble'); if (b) b.style.display = 'none'; }
      if (hostEl) hostEl.style.display = 'none';
      sendResponse({ success: true });
    } else if (request.action === 'MIC_STATUS') {
      if (shadow) { const m = shadow.getElementById('mic'); if (m) { m.textContent = request.connected ? '🎤 Your voice: recording' : '⚠ Your voice NOT captured — Enable mic in Settings'; m.style.color = request.connected ? '#34d399' : '#fca5a5'; } }
    } else if (request.action === 'AUDIO_STATUS') {
      if (shadow) { const a = shadow.getElementById('aud'); if (a) { a.textContent = request.ok ? '' : '⚠ ' + (request.text || 'No meeting audio detected'); a.style.color = '#fca5a5'; } }
    }
    return false;
  });
})();
