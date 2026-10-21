// backend/hardening/validate.js — tiny request-body validator (no dependencies).
// schema: { field: { type:'string'|'number'|'integer'|'boolean'|'array'|'object', required, max, min, re, enum, items } }
// Unknown fields are dropped (not passed on); wrong types / sizes are rejected with a clear 400.
function check(name, v, rule) {
  const bad = (m) => `${name}: ${m}`;
  switch (rule.type) {
    case 'string':
      if (typeof v !== 'string') return bad('text hona chahiye');
      if (rule.max && v.length > rule.max) return bad(`max ${rule.max} akshar`);
      if (rule.min && v.length < rule.min) return bad(`kam se kam ${rule.min} akshar`);
      if (rule.re && !rule.re.test(v)) return bad('format galat hai');
      if (rule.enum && !rule.enum.includes(v)) return bad(`inme se ek: ${rule.enum.join(', ')}`);
      return null;
    case 'number': case 'integer': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return bad('number hona chahiye');
      if (rule.type === 'integer' && !Number.isInteger(n)) return bad('poora number hona chahiye');
      if (rule.min !== undefined && n < rule.min) return bad(`kam se kam ${rule.min}`);
      if (rule.max !== undefined && n > rule.max) return bad(`zyada se zyada ${rule.max}`);
      return null;
    }
    case 'boolean': return typeof v === 'boolean' ? null : bad('true/false hona chahiye');
    case 'array':
      if (!Array.isArray(v)) return bad('list hona chahiye');
      if (rule.max && v.length > rule.max) return bad(`max ${rule.max} items`);
      if (rule.items) for (const it of v) { const e = check(name + '[]', it, rule.items); if (e) return e; }
      return null;
    case 'object': return v && typeof v === 'object' && !Array.isArray(v) ? null : bad('object hona chahiye');
    default: return bad('unknown rule');
  }
}
function validate(schema, opts) {
  const where = (opts && opts.where) || 'body';
  return function validator(req, res, next) {
    const src = req[where];
    if (src === undefined || src === null || typeof src !== 'object' || Array.isArray(src)) return res.status(400).json({ error: 'Request body JSON object hona chahiye' });
    const clean = {};
    for (const [k, rule] of Object.entries(schema)) {
      const v = src[k];
      if (v === undefined || v === null || v === '') { if (rule.required) return res.status(400).json({ error: `${k}: zaroori hai` }); continue; }
      const err = check(k, v, rule);
      if (err) return res.status(400).json({ error: err });
      clean[k] = (rule.type === 'number' || rule.type === 'integer') && typeof v === 'string' ? Number(v) : v;
    }
    req[where] = clean;
    next();
  };
}
module.exports = { validate, check };
