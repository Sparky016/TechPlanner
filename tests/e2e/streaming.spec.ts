import { expect, test } from '@playwright/test';
import { createSession, login, resetAll, section, startMessage, waitForTurnEnd } from './support/helpers';

const PATCH_TEXT = 'E2E live patch: users export the report as CSV.';

interface Timing {
  tokenAt: number[];
  patchAt: number | null;
  visibleAt: number | null;
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-4: AI answers stream and a section patch appears in the center panel within 1 s of the patch event', async ({
  page,
}) => {
  // Timestamps (performance.now) for SSE frames as they arrive and for the patched text appearing in the DOM.
  await page.addInitScript((patchText: string) => {
    const timing: Timing = { tokenAt: [], patchAt: null, visibleAt: null };
    (window as unknown as { __e2eTiming: Timing }).__e2eTiming = timing;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/sessions\/[^/]+\/messages$/.test(url) || init?.method !== 'POST' || !res.body) return res;
      const [forApp, forTiming] = res.body.tee();
      void (async () => {
        const reader = forTiming.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const now = performance.now();
          buffer += decoder.decode(value, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.includes('event: token')) timing.tokenAt.push(now);
            if (frame.includes('event: patch') && timing.patchAt === null) timing.patchAt = now;
            end = buffer.indexOf('\n\n');
          }
        }
      })();
      return new Response(forApp, { status: res.status, statusText: res.statusText, headers: res.headers });
    };

    new MutationObserver(() => {
      if (timing.visibleAt !== null) return;
      const el = document.querySelector('[data-section="Executive Summary"]');
      if (el?.textContent?.includes(patchText)) timing.visibleAt = performance.now();
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, PATCH_TEXT);

  await login(page);
  await createSession(page, 'ABC-123');

  await startMessage(page, 'Please summarise the goal. #stream');
  // Partial text is on screen while the turn is still running.
  await expect(page.getByTestId('streaming-reply')).toContainText('Streaming the first part of the answer.');
  await expect(page.getByTestId('streaming-reply')).not.toContainText('The Executive Summary is updated.');
  await waitForTurnEnd(page);

  const summary = section(page, 'Executive Summary');
  await expect(summary).toContainText(PATCH_TEXT);
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText('The Executive Summary is updated.');

  const timing = await page.evaluate(() => (window as unknown as { __e2eTiming: Timing }).__e2eTiming);
  expect(timing.tokenAt.length).toBeGreaterThanOrEqual(3);
  // Tokens arrived spread over the turn (streamed), not in one final burst.
  expect(timing.tokenAt[timing.tokenAt.length - 1] - timing.tokenAt[0]).toBeGreaterThan(500);
  expect(timing.patchAt).not.toBeNull();
  expect(timing.visibleAt).not.toBeNull();
  expect(timing.visibleAt! - timing.patchAt!).toBeLessThanOrEqual(1_000);
});
