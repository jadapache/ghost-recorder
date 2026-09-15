// Ghost Recorder — Note templates (Fathom-style).
// Each template is a markdown skeleton the AI fills. Loaded in the offscreen doc
// (for prompt building) and referenced by id in settings.

(function () {
  const TEMPLATES = {
    general: {
      label: 'General meeting',
      skeleton: `# Meeting Notes — {{title}}
**Date:** {{date}}  ·  **Duration:** {{duration}}  ·  **Platform:** {{platform}}
**Participants:** {{participants or "Unknown"}}

## TL;DR
{{2-3 sentence summary of why this meeting happened and the outcome}}

## Key Points
- {{point}}

## Decisions
- {{decision}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date if stated)}}

## Open Questions / Parking Lot
- {{question}}`,
    },
    sales: {
      label: 'Sales / discovery call',
      skeleton: `# Sales Call — {{prospect_company}}
**Date:** {{date}}  ·  **Attendees:** {{names + titles}}  ·  **Stage:** {{discovery | demo | negotiation | unknown}}

## Summary
{{3-4 sentences}}

## Pain Points / Needs
- {{pain}}

## BANT / Qualification
- **Budget:** {{stated or "not discussed"}}
- **Authority (decision makers):** {{who}}
- **Need:** {{core need}}
- **Timeline:** {{when}}

## Objections Raised
- {{objection}} → {{response / resolution}}

## Competitors Mentioned
- {{competitor}}

## Next Steps
- [ ] {{owner}} — {{commitment}} {{(due: date)}}

## CRM-Ready Snippet
{{one paragraph the rep can paste into the deal note}}`,
    },
    one_on_one: {
      label: '1:1 / Standup',
      skeleton: `# {{"1:1" | "Standup"}} — {{names or team}}
**Date:** {{date}}

## Progress / Accomplishments
- {{done}}

## Blockers / Impediments
- {{blocker}}

## Ideas / Experiments to Try
- {{improvement}}

## Action Items (committed changes)
- [ ] {{owner}} — {{task}} {{(due: date)}}

## Kudos
- {{shout-out}}`,
    },
  };

  function systemPrompt(id, meta, opts) {
    const t = TEMPLATES[id] || TEMPLATES.general;
    const m = meta || {};
    const includeTranscript = !opts || opts.includeTranscript !== false;
    const lang = (opts && opts.language) || (m && m.language) || 'auto';
    const langDirective = self.GhostI18n ? self.GhostI18n.getLanguagePromptDirective(lang) : '';

    return `You are an elite meeting-notes writer — the quality bar is Fathom/Notion AI. A busy executive should get everything they need from your notes WITHOUT watching the meeting. Produce GitHub-flavored Markdown that fills the EXACT skeleton below.

${langDirective}

QUALITY RULES (these are what separate great notes from useless ones):
- Preserve every heading verbatim. Omit a section only if there is genuinely NO content for it; never invent facts.
- SPECIFICITY OVER SUMMARY: keep real numbers, names, dates, amounts, and product terms exactly as spoken. A note that could have been written without attending the meeting is a FAILED note.
- ACTION ITEMS — extract EVERY commitment, including ones made in passing ("I'll send that deck"). Each item: verb-first, concrete, with owner and stated deadline: "- [ ] Owner — task (due: date)". Use a real name when known, else "Unassigned".
- DECISIONS vs actions: a decision is something now settled; record who made it. Don't duplicate decisions as action items.
- TL;DR/Summary: 2-4 sentences a CEO would actually read — what was the point, what changed, what happens next.
- Capture disagreements, risks, and open questions honestly.
- Quote verbatim (with quotation marks) when someone's exact words matter.
- Skip pleasantries, small talk, and connection issues entirely.
- Known context — Date: ${m.date || 'Unknown'} · Platform: ${m.platform || 'Unknown'} · Duration: ${m.duration || 'Unknown'}.
- Use REAL speaker names from the provided captions/speaker hints wherever possible.
- SPEAKER DIARIZATION: The audio stream is captured in multi-channel format (Right channel = local participant "You", Left channel = remote call participants). Identify local participant statements as "You" and remote participants using their real names or consistent "Speaker 1", "Speaker 2" labels.${includeTranscript ? `
- After the skeleton, add a "## Full Transcript" section. STRICT FORMAT — every line MUST be exactly: "[mm:ss] Speaker: text" (use [h:mm:ss] past one hour). No bold, no bullets, no extra prose.
- TIMESTAMP ACCURACY IS CRITICAL: [mm:ss] must be the actual position in the audio where that sentence STARTS. Never bunch timestamps or reset them; they must increase monotonically through the whole audio, ending near the meeting duration given above.
- SPEAKER ACCURACY: distinguish speakers by voice and channel. Detect speaker changeovers at every turn. Label speakers consistently.
- Transcribe the ENTIRE audio start to finish — do not summarize, skip, or stop early.` : ''}
- If the audio/transcript is empty or silent, output only "# Meeting Notes — ${m.date || ''}" then "No spoken audio detected."

SKELETON:
${t.skeleton}`;
  }

  self.GhostTemplates = {
    list: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })),
    get: (id) => ({ id: TEMPLATES[id] ? id : 'general', skeleton: (TEMPLATES[id] || TEMPLATES.general).skeleton, systemPrompt: (meta, opts) => systemPrompt(id, meta, opts) }),
  };
})();
