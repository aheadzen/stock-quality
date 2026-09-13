import OpenAI from 'openai';

let cachedClient = null;

export function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: 'https://api.minimax.io/v1',
  });
  return cachedClient;
}

export const MODEL = 'MiniMax-M3';