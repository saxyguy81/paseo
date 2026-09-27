import { expect, test } from "../support/fixtures";
import { trackAgentTimelineRequests } from "../support/helpers/agent-timeline-gate";
import {
  openAgentTimeline,
  expectTimelinePromptVisible,
  seedLongMockAgentTimeline,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("scrolls into the previous session on mobile without expanding full history", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const previous = await seedMockAgentWorkspace({
    repoPrefix: "family-pagination-",
    title: "Previous session",
    model: "ten-second-stream",
    initialPrompt: "previous-session-marker: emit 1 coalesced agent stream updates",
  });
  await previous.client.waitForFinish(previous.agentId, 15_000);
  const current = await seedLongMockAgentTimeline({ turns: 24 });
  const prompts = current.prompts;
  try {
    const labels = {
      "paseo.family.id": current.agentId,
      "paseo.family.current": current.agentId,
      "paseo.family.name": "History boundary regression",
    };
    await current.client.updateAgent(previous.agentId, {
      labels: { ...labels, "paseo.family.position": "0" },
    });
    await current.client.updateAgent(current.agentId, {
      labels: { ...labels, "paseo.family.position": "1" },
    });
    const previousRequests = await trackAgentTimelineRequests(page, previous.agentId);
    await openAgentTimeline(page, current);
    await expectTimelinePromptVisible(page, prompts.at(-1)!);
    await expect(page.getByTestId("conversation-family-search")).toBeHidden();
    expect(previousRequests.requests()).toHaveLength(0);

    // Exhaust the current session, then cross its boundary. Neither step uses
    // the search disclosure, which must not control timeline pagination.
    await userScrollsTimelineToHistoryStart(page);
    await userScrollsTimelineToHistoryStart(page);
    await expect.poll(() => previousRequests.requests().length).toBe(1);
    await userScrollsTimelineToHistoryStart(page);
    await expect(
      page.getByText("previous-session-marker: emit 1 coalesced agent stream updates", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("conversation-family-search")).toBeHidden();
    await page.getByTestId("conversation-family-disclosure").click();
    await page.getByTestId("conversation-family-search").fill("previous-session-marker");
    await expect(page.getByTestId("conversation-family-match-count")).toContainText("1");
  } finally {
    await current.cleanup();
    await previous.cleanup();
  }
});
