import { getHandlers } from '@/server/jobs/registry';
import { getQueue, stopQueue, subscribeHandlers } from '@/server/jobs/queue';
import './handlers';

// Server-only: never import from src/lib or client components.

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, shutting down`);
  try {
    await stopQueue();
    process.exit(0);
  } catch (err) {
    console.error('[worker] error during shutdown', err);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await getQueue();
  await subscribeHandlers(getHandlers());
  console.log(`[worker] started with ${getHandlers().size} handler(s)`);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});
