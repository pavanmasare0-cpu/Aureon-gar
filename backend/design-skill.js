// backend/design-skill.js — the "UI/UX skill" Ava applies whenever she designs a screen or writes an app with a user interface.
// Source: DESIGN-SYSTEM.md (Aureon design system). Kept as plain strings so it can be pasted into any LLM prompt.
// Note: generated prototypes must stay standalone (no CDN / web fonts), so the font stack is system-ui here.

const TOKENS = [
  'Use CSS variables as design tokens, never raw hex inside components:',
  '--bg:#0B0F14; --surface:#131A22; --surface-2:#1B2530; --border:#263340; --text:#E6EDF3; --text-muted:#9AA7B4;',
  '--accent:#5B9BFF (primary actions) with --on-accent:#07101C (dark text on accent, white fails contrast); --rec:#FF6B6B; --success:#4ADE80; --warn:#FBBF24;',
  'font: system-ui,-apple-system,"Segoe UI",sans-serif; body 16px minimum, small text 13px, line-height 1.5;',
  'spacing on a 4px grid (4/8/12/16/24/32); radius 8/16/24/999; motion 150-220ms; respect env(safe-area-inset-top/bottom).',
].join(' ');

const RULES = [
  'Every text/background pair must have contrast of at least 4.5:1.',
  'Every tappable element is at least 44x44px with 8px+ gap between targets; visible :focus-visible ring.',
  'Icons: one consistent inline-SVG set, no emoji as functional icons.',
  'Always show state as text, not only colour (Listening / Thinking / Speaking / Done, errors next to the field).',
  'Loading shows a skeleton or "Thinking…" message, never a frozen screen; add empty-state and error-state screens.',
  'Respect prefers-reduced-motion; keep animation light (no heavy blur filters).',
  'No horizontal scroll at 360px width; test mentally at 360, 412 and desktop widths; sticky input bars respect the keyboard and safe-area inset.',
  'Attachment/image previews are small thumbnails (72px) and images inside messages are capped (max-height 240px, object-fit: contain).',
].join(' ');

const FINISH = [
  'PERFECT FINISHING: the result must feel like a shipped product, not a demo.',
  'Include a real app shell (header/navigation), realistic sample data, working interactions, hover/active/disabled states,',
  'empty / loading / error states, form validation messages, consistent spacing and typography, and a short README on how to run it.',
].join(' ');

/** Rules for designing ONE screen / prototype (appended to the UI designer prompts). */
const UI_SKILL = 'UI/UX SKILL (mandatory): ' + TOKENS + ' ' + RULES + ' ' + FINISH;

/** Clause for the software-engineer prompt: only applies if the project has a user interface. */
const ENGINEER_UI_CLAUSE = 'If the project has ANY user interface (web page, dashboard, mobile/Android app screen), also follow this UI/UX skill strictly: ' + TOKENS + ' ' + RULES + ' ' + FINISH;

module.exports = { UI_SKILL, ENGINEER_UI_CLAUSE, TOKENS, RULES, FINISH };
