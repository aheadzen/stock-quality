import fs from 'node:fs';
import path from 'node:path';

// Kinds that map to the "company" question set. Everything else (currently
// just 'crypto') falls into its own bucket.
const COMPANY_KINDS = new Set(['listed', 'ipo', 'unlisted']);

export function questionKindFor(kind) {
  if (kind === 'crypto') return 'crypto';
  return 'company'; // listed, ipo, unlisted, undefined, unknown → company
}

export function loadQuestions(kind = 'company', filePath = './questions.json') {
  const absPath = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Questions file not found: ${absPath}`);
    }
    throw new Error(`Failed to read questions file ${absPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${absPath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${absPath} must be a JSON object with kind-keyed question arrays.`);
  }

  const sectionKey = questionKindFor(kind);
  const questions = parsed[sectionKey];
  if (!Array.isArray(questions)) {
    throw new Error(
      `${absPath} is missing a "${sectionKey}" array (entity kind: ${kind}).`
    );
  }

  const cleaned = questions
    .map((q) => (typeof q === 'string' ? q.trim() : q))
    .filter((q) => typeof q === 'string' && q.length > 0);

  if (cleaned.length === 0) {
    throw new Error(`${absPath} has an empty "${sectionKey}" array.`);
  }

  return cleaned;
}