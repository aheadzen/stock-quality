import 'dotenv/config';

export function loadConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error(
      'MINIMAX_API_KEY is not set. Copy .env.example to .env and set your key.'
    );
  }
  return { apiKey };
}