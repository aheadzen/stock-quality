import pLimit from 'p-limit';
import {
  evaluateQuestion,
  evaluateBatch,
  RateLimitError,
} from './evaluator.js';
import { getConcurrency } from './settings.js';

// Fan out evaluations with capped concurrency. Returns one result per question
// in the original order. Each failed question becomes { question, error }.
//
// When `batchSize` from settings is > 1, questions are chunked into groups of
// that size and each group is answered in a single LLM round-trip — far fewer
// API calls and lower token overhead than per-question.
//
// RateLimitError is NOT caught here — it bubbles to the caller (the queue
// processor) so it can pause the pipeline. All other errors become per-
// question error entries so the rest of the run still completes.
export async function runEvaluations(
  client,
  questions,
  companyContext,
  { concurrency = 5, onResult = null, signal = null } = {}
) {
  const { batchSize = 1 } = getConcurrency();
  const limit = pLimit(concurrency);

  if (batchSize <= 1) {
    // Original per-question path: one round-trip per question, fan out with
    // p-limit(concurrency). Best when latency matters more than throughput.
    const tasks = questions.map((question, index) =>
      limit(async () => {
        let result;
        try {
          const r = await evaluateQuestion(client, question, companyContext, { signal });
          result = { index, question, ...r };
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          result = {
            index,
            question,
            score: null,
            reasoning: '',
            error: err?.message || String(err),
          };
        }
        if (onResult) {
          try {
            await onResult(result);
          } catch {
            /* swallow hook errors */
          }
        }
        return result;
      })
    );
    return Promise.all(tasks);
  }

  // Batched path: chunk into groups of `batchSize`, one round-trip per chunk.
  // Inside each batch, partial failures (bad individual elements) are tolerated
  // and surfaced as per-question errors.
  const chunks = [];
  for (let i = 0; i < questions.length; i += batchSize) {
    chunks.push({ start: i, items: questions.slice(i, i + batchSize) });
  }

  const tasks = chunks.map((chunk) =>
    limit(async () => {
      let results;
      try {
        results = await evaluateBatch(client, chunk.items, companyContext, {
          signal,
          startIndex: chunk.start,
        });
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        // Whole-batch failure → every question in the chunk is errored.
        results = chunk.items.map((q, j) => ({
          index: chunk.start + j,
          question: q,
          score: null,
          reasoning: '',
          error: err?.message || String(err),
        }));
      }
      for (const r of results) {
        if (onResult) {
          try {
            await onResult(r);
          } catch {
            /* swallow hook errors */
          }
        }
      }
      return results;
    })
  );
  const nested = await Promise.all(tasks);
  return nested.flat();
}