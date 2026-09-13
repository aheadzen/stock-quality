import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function resolveInput(argv = process.argv) {
  const fromArgv = (argv[2] || '').trim();
  if (fromArgv) return fromArgv;

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question('Enter company name or ticker: ');
      const trimmed = (answer || '').trim();
      if (trimmed) return trimmed;
      process.stderr.write('Please enter a non-empty value.\n');
    }
  } finally {
    rl.close();
  }
}