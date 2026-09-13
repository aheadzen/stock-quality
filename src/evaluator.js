import { MODEL } from './client.js';
import { TOOLS, TOOL_CHOICE } from './tools.js';
import {
  buildEvalMessages,
  buildBatchedEvalMessages,
  buildStrictRetryMessages,
} from './prompts.js';

// Distinct error class so callers can react to 429s without string-matching
// error messages. The OpenAI SDK sets `status` on its APIError subclasses.
export class RateLimitError extends Error {
  constructor(original) {
    const msg = original?.message || 'Rate limited (429)';
    super(msg);
    this.name = 'RateLimitError';
    this.status = 429;
    this.original = original;
  }
}

function isRateLimit(err) {
  if (!err) return false;
  if (err.status === 429 || err.statusCode === 429) return true;
  const m = String(err.message || '');
  if (m.includes('429')) return true;
  if (m.toLowerCase().includes('rate limit')) return true;
  if (m.includes('Upgrade your Token Plan') || m.includes('pay-as-you-go')) return true;
  return false;
}

// runToolLoop: drives a chat.completions conversation until the model stops.
// Handles two shapes defensively:
//   (a) server-executed tools: assistant returns a final answer (content + finish_reason=stop)
//   (b) client-dispatched tools: assistant returns tool_calls; we stub them and continue
//       (since we have no client-side web_search implementation, the model will fall back
//        to its own knowledge for the next iteration)
export async function runToolLoop(client, messages, { maxIterations = 5, signal } = {}) {
  const history = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: history,
        tools: TOOLS,
        tool_choice: TOOL_CHOICE,
        signal,
      });
    } catch (err) {
      if (isRateLimit(err)) throw new RateLimitError(err);
      throw err;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('Model returned no choices.');
    }

    const message = choice.message;
    history.push(message);

    const finishReason = choice.finish_reason;
    const toolCalls = message.tool_calls;

    // No tool calls -> final answer.
    if (!toolCalls || toolCalls.length === 0) {
      return message.content ?? '';
    }

    // Tool calls returned: server didn't execute them, so stub each result.
    // We append tool-role messages so the model can continue.
    for (const call of toolCalls) {
      const fnName = call.function?.name ?? 'unknown';
      let args = call.function?.arguments ?? '{}';
      if (typeof args !== 'string') args = JSON.stringify(args);

      // Stub: we have no client-side web_search. Tell the model it should
      // rely on its own knowledge and continue with the conversation.
      const stubResult =
        `Tool "${fnName}" is not available client-side. ` +
        `Use your training knowledge or known facts to proceed. ` +
        `(Original request: ${args})`;

      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: stubResult,
      });
    }

    // Loop continues.
  }

  // Exhausted iterations: return whatever the last message had.
  const last = history[history.length - 1];
  return last?.content ?? '';
}

// Strip reasoning-style blocks the model may emit before the answer. Common
// variants: <think>...</think>, <reasoning>...</reasoning>, <thought>...</thought>.
// Tolerates multiple occurrences, nested tags, and unclosed tags (those get
// stripped up to the next JSON-like char or end of string).
const REASONING_TAGS = '(?:think|thinking|reasoning|thought|reflection|analysis|assistant_thought)';
const REASONING_BLOCK_RE = new RegExp(
  `<${REASONING_TAGS}\\b[^>]*>[\\s\\S]*?</\\1>`,
  'gi'
);
const REASONING_UNCLOSED_RE = new RegExp(
  `<${REASONING_TAGS}\\b[^>]*>[\\s\\S]*?(?=\\[|\\{|$)`,
  'gi'
);

function stripReasoning(text) {
  return text
    .replace(REASONING_BLOCK_RE, '')
    .replace(REASONING_UNCLOSED_RE, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// Strict-JSON parse: extract a JSON object from arbitrary text.
// Tries: full content -> first {...} block -> balanced brace scan.
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  const stripped = stripReasoning(text);

  // Try the whole thing first.
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through.
  }

  // Try the first {...} block.
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = stripped.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Try a balanced scan starting from firstBrace.
      return balancedScan(stripped, firstBrace);
    }
  }

  return null;
}

function balancedScan(text, start) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Extract a JSON array from arbitrary text. Mirrors extractJson but looks
// for the first [...] block instead of the first {...} block.
export function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;

  const stripped = stripReasoning(text);

  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }

  const firstBracket = stripped.indexOf('[');
  const lastBracket = stripped.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = stripped.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return null;
}

export async function evaluateQuestion(client, question, companyContext, { signal } = {}) {
  let messages = buildEvalMessages(question, companyContext);
  let raw = await runToolLoop(client, messages, { signal });

  let parsed = extractJson(raw);
  if (parsed && isValidEvalShape(parsed)) {
    return normalizeEval(parsed);
  }

  // Retry once with stricter prompt.
  messages = [...messages, { role: 'assistant', content: raw }, ...buildStrictRetryMessages(raw)];
  try {
    raw = await runToolLoop(client, messages, { signal });
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    throw err;
  }
  parsed = extractJson(raw);
  if (parsed && isValidEvalShape(parsed)) {
    return normalizeEval(parsed);
  }

  throw new Error(
    `Failed to parse a valid {score, reasoning} JSON object from the model. Raw: ${truncate(raw)}`
  );
}

// Batched variant: ask the model to answer N questions in one round-trip.
// Returns N result objects in the same order as the input questions. Each
// element is either a normalized {score, reasoning} or an error entry if the
// model produced an unparseable shape for that index.
export async function evaluateBatch(client, questions, companyContext, { signal, startIndex = 0 } = {}) {
  if (!questions || questions.length === 0) return [];

  let messages = buildBatchedEvalMessages(questions, companyContext);
  let raw = await runToolLoop(client, messages, { signal });
  let arr = extractJsonArray(raw);

  let mapped = mapBatchArray(raw, arr, questions, startIndex);
  if (mapped) return mapped;

  // Retry once with stricter prompt.
  messages = [...messages, { role: 'assistant', content: raw }, ...buildStrictRetryMessages(raw)];
  try {
    raw = await runToolLoop(client, messages, { signal });
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    throw err;
  }
  arr = extractJsonArray(raw);
  mapped = mapBatchArray(raw, arr, questions, startIndex);
  if (mapped) return mapped;

  throw new Error(
    `Failed to parse a JSON array of ${questions.length} {score, reasoning} objects. Raw: ${truncate(raw)}`
  );
}

// Translate a (possibly partial) model response into per-question results.
// Returns null if the array couldn't be parsed at all so the caller can retry.
// `startIndex` is added to each local index so the persisted `idx` matches
// the question's position in the full checklist (not within the chunk).
function mapBatchArray(raw, arr, questions, startIndex = 0) {
  if (!Array.isArray(arr)) return null;
  return questions.map((q, i) => {
    const item = arr[i];
    if (item && isValidEvalShape(item)) {
      return { index: startIndex + i, question: q, ...normalizeEval(item) };
    }
    return {
      index: startIndex + i,
      question: q,
      score: null,
      reasoning: '',
      error: item
        ? `Invalid item at index ${i}: ${truncate(JSON.stringify(item), 80)}`
        : `Missing item at index ${i}`,
    };
  });
}

function isValidEvalShape(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    (obj.score === 0 || obj.score === 1) &&
    typeof obj.reasoning === 'string'
  );
}

function normalizeEval(obj) {
  return {
    score: obj.score === 1 ? 1 : 0,
    reasoning: obj.reasoning.trim(),
  };
}

function truncate(s, n = 300) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}...` : s;
}