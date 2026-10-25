// backend/code-skill.js — the shared "coding knowledge" for Ava (writing + reviewing project code) and for Aureon's Coding-mode chat.
// Plain strings only, so they can be pasted into any LLM prompt. Nothing here runs code.

const RULES = [
  'Write COMPLETE, runnable code: no TODO / placeholder / "implement here" / pseudo-code. Every function you call must exist, every import path must point to a real file.',
  'Use EXACTLY the names, exports and signatures of the files you were shown (outlines). Never invent a function that another file does not export.',
  'Validate input at the edges: empty / null / NaN / wrong type / huge input. Wrap JSON.parse and file/network access in try/catch and show a clear error.',
  'Async: await every promise, never use async callbacks inside forEach, handle rejections, clear timers and listeners, avoid race conditions (double click, double submit).',
  'DOM: every id used in JavaScript must exist in the HTML. Put user text in with textContent (never raw innerHTML). Check null before using querySelector results.',
  'Security: no eval / new Function, no secrets in code, no path traversal, parameterised queries only, escape output.',
  'Think about edge cases before you write: empty list, one item, duplicates, offline, very long text, wrong order of calls.',
  'Tests must assert real behaviour (never assert(true)); cover the normal case, an edge case and an error case.',
  'Small functions with one job, clear names, comments only where the reason is not obvious.',
].join(' ');

const SELF_CHECK = 'SELF-CHECK before you answer: trace your code with 2-3 sample inputs including an empty/edge one, confirm every variable, function and import is defined, and that names match the existing files.';

/** Appended to Ava's software-engineer prompt (project files). */
const CODING_KNOWLEDGE = 'CODING KNOWLEDGE (follow strictly; most real-world failures are plain bugs, so hunt for them while you write): ' + RULES + ' ' + SELF_CHECK;

/** Reviewer prompt: finds REAL bugs only. */
const BUG_HUNT = 'You are Ava acting as a ruthless senior code reviewer. Find REAL bugs only (things that crash or give wrong results): undefined variables or functions, names/arguments that do not match the other files (use the OUTLINES), null/undefined access, wrong await/async use, off-by-one, wrong event or element ids, XSS through innerHTML, resource leaks, wrong logic for empty or edge input. IGNORE style, naming and "could be improved" remarks. If the code is fine return an empty list.';

/** Appended to Aureon Coding-mode chat prompt. */
const CODING_KNOWLEDGE_CHAT = 'ENGINEERING RULES FOR EVERY ANSWER: ' + RULES + ' ' + SELF_CHECK + ' For JavaScript tests use ONLY what the sandbox has: the built-in node:test + node:assert/strict (or plain describe/it/expect, which the sandbox provides). No npm packages (no mocha, chai, supertest). Put the implementation in its own code block FIRST, then the tests in a second block that imports it with a relative path (require("./solution") or import ... from "./solution.js"); both must run with plain node. The server syntax-checks your code blocks after you answer, so syntax slips are caught, but LOGIC bugs are not: hunt for those yourself before you send, and say honestly what you could not test.';

module.exports = { CODING_KNOWLEDGE, BUG_HUNT, CODING_KNOWLEDGE_CHAT, RULES };
