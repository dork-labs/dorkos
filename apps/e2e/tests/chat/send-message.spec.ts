import { test, expect } from '../../fixtures';

test.describe('Chat — Send Message @integration', () => {
  test.describe.configure({ timeout: 90_000 });

  test('sends a message and receives a streaming response', async ({ chatPage }) => {
    await chatPage.sendMessage('Respond with exactly: hello world');
    await chatPage.waitForResponse();

    const lastMessage = await chatPage.lastAssistantMessage();
    await expect(lastMessage).toContainText('hello world');
  });

  test('inference indicator shows streaming then complete lifecycle', async ({ chatPage }) => {
    await chatPage.sendMessage('Count from 1 to 5 slowly');

    // Streaming indicator appears while response is generating
    await expect(chatPage.inferenceStreaming).toBeVisible({ timeout: 10_000 });

    // Wait for streaming to finish
    await chatPage.waitForResponse();

    // Streaming indicator gone; complete indicator appears
    await expect(chatPage.inferenceStreaming).toBeHidden();
    await expect(chatPage.inferenceComplete).toBeVisible({ timeout: 5_000 });
  });

  test('assistant message renders markdown after stream ends', async ({ chatPage }) => {
    // Ask for content with common markdown elements
    await chatPage.sendMessage(
      'Respond with a short markdown example: one heading (##), one bold word, and one bullet list item.'
    );
    await chatPage.waitForResponse();

    const lastMessage = await chatPage.lastAssistantMessage();

    // Markdown is rendered — heading and list elements should be in the DOM
    await expect(lastMessage.locator('h2, h3')).toBeVisible({ timeout: 5_000 });
    await expect(lastMessage.locator('ul li, strong')).toBeVisible({ timeout: 5_000 });
  });

  test('tool calls display as collapsible cards', async ({ chatPage }) => {
    // Trigger a tool call by asking Claude to read a file it can access
    await chatPage.sendMessage(
      'Use the Read tool to read the file /etc/hostname, then tell me what it contains.'
    );

    // Tool call cards should appear during or after streaming
    await expect(chatPage.toolCallCards.first()).toBeVisible({ timeout: 20_000 });

    // Cards are collapsed by default — click to expand
    const firstCard = chatPage.toolCallCards.first();
    const toggleButton = firstCard.getByRole('button');
    await expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    await toggleButton.click();
    await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    // Collapse again
    await toggleButton.click();
    await expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  });

  test('message history loads when switching sessions', async ({ chatPage, sessionSidebar }) => {
    // Send a message in the current session to create history
    await chatPage.sendMessage('Say: session history test marker');
    await chatPage.waitForResponse();

    const sessionId = await chatPage.getSessionId();
    expect(sessionId).toBeTruthy();

    // Create a new session to navigate away
    await sessionSidebar.createNewSession();
    await expect(chatPage.panel).toBeVisible({ timeout: 10_000 });

    // Navigate back to the original session via URL
    await chatPage.goto(sessionId!);

    // Message history should reload with the original message visible
    const messages = await chatPage.getMessages();
    await expect(messages.first()).toBeVisible({ timeout: 10_000 });
    await expect(chatPage.messageList).toContainText('session history test marker');
  });
});
