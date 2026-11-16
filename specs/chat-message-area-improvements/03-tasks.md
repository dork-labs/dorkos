# Tasks: Chat Message Area Improvements

**Spec**: `specs/chat-message-area-improvements/02-specification.md`
**Generated**: 2026-02-13

---

## Phase 1: Defer Assistant Message Creation

### Task 1.1: Modify `use-chat-session.ts` to defer assistant message creation

**File**: `apps/client/src/hooks/use-chat-session.ts`
**activeForm**: deferring assistant message creation until first content event arrives

**Description**:

Currently, `handleSubmit` eagerly creates an empty assistant message (lines 177-185) with `content: ''` and `parts: []` before any SSE events arrive. This causes an empty assistant bubble with a dot indicator to appear for several seconds before streaming starts. The fix defers message creation until the first content event.

**Implementation steps**:

1. Add two new refs after line 84 (`currentPartsRef`):

   ```typescript
   const assistantIdRef = useRef<string>('');
   const assistantCreatedRef = useRef(false);
   ```

2. In `handleSubmit`, **remove** the eager assistant message creation block (lines 177-185):

   ```typescript
   // REMOVE THIS BLOCK:
   const assistantId = crypto.randomUUID();
   setMessages((prev) => [
     ...prev,
     {
       id: assistantId,
       role: 'assistant',
       content: '',
       toolCalls: [],
       parts: [],
       timestamp: new Date().toISOString(),
     },
   ]);
   ```

3. Replace it with ref-based ID tracking:

   ```typescript
   assistantIdRef.current = crypto.randomUUID();
   assistantCreatedRef.current = false;
   ```

4. Update the `transport.sendMessage` callback to use the ref:

   ```typescript
   await transport.sendMessage(
     sessionId,
     finalContent,
     (event) => handleStreamEvent(event.type, event.data, assistantIdRef.current),
     abortController.signal,
     selectedCwd ?? undefined
   );
   ```

5. Add an `ensureAssistantMessage` function inside the hook:

   ```typescript
   function ensureAssistantMessage(assistantId: string) {
     if (!assistantCreatedRef.current) {
       assistantCreatedRef.current = true;
       setMessages((prev) => [
         ...prev,
         {
           id: assistantId,
           role: 'assistant',
           content: '',
           toolCalls: [],
           parts: [],
           timestamp: new Date().toISOString(),
         },
       ]);
     }
   }
   ```

6. Call `ensureAssistantMessage(assistantId)` at the start of `updateAssistantMessage`:

   ```typescript
   function updateAssistantMessage(assistantId: string) {
     ensureAssistantMessage(assistantId);
     const parts = currentPartsRef.current.map((p) => ({ ...p }));
     const derived = deriveFromParts(parts);
     setMessages((prev) =>
       prev.map((m) =>
         m.id === assistantId
           ? {
               ...m,
               content: derived.content,
               toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : [],
               parts,
             }
           : m
       )
     );
   }
   ```

7. Edge case: if `done` arrives without any content events, no assistant message is created. This is correct behavior.

**Acceptance criteria**:

- After `handleSubmit`, messages array contains only the user message (no empty assistant message)
- Assistant message is created on first `text_delta`, `tool_call_start`, `approval_required`, or `question_prompt` event
- Subsequent events update the message, not duplicate it
- `done` without prior content events does not create an assistant message
- History-loaded messages render normally (no regression)

---

### Task 1.2: Update `use-chat-session.test.tsx` with deferred creation tests

**File**: `apps/client/src/hooks/__tests__/use-chat-session.test.tsx`
**activeForm**: adding unit tests for deferred assistant message creation

**Description**:

Add tests to verify the deferred assistant message creation behavior. Also update existing tests that assume the eager creation pattern (e.g., `adds user message on submit and clears input` which currently expects `messages.toHaveLength(2)` immediately after submit with only a `done` event).

**New tests to add**:

1. **"does not create assistant message immediately on submit"**:

   ```typescript
   it('does not create assistant message immediately on submit', async () => {
     // sendMessage that hangs (never resolves) so we can inspect state mid-stream
     const sendMessage = vi.fn(() => new Promise<void>(() => {}));
     const transport = createMockTransport({ sendMessage });
     const { result } = renderHook(() => useChatSession('s1'), {
       wrapper: createWrapper(transport),
     });

     await waitFor(() => expect(result.current.status).toBe('idle'));

     await act(async () => {
       result.current.setInput('Hello');
     });

     // Start submit but don't await (it hangs)
     act(() => {
       result.current.handleSubmit();
     });

     // Only the user message should exist — no empty assistant message
     await waitFor(() => {
       expect(result.current.messages).toHaveLength(1);
       expect(result.current.messages[0].role).toBe('user');
     });
   });
   ```

2. **"creates assistant message on first text_delta"**:

   ```typescript
   it('creates assistant message on first text_delta', async () => {
     const sendMessage = createSendMessageMock([
       { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent,
       { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
     ]);
     const transport = createMockTransport({ sendMessage });
     const { result } = renderHook(() => useChatSession('s1'), {
       wrapper: createWrapper(transport),
     });

     await waitFor(() => expect(result.current.status).toBe('idle'));

     await act(async () => {
       result.current.setInput('Hi');
     });
     await act(async () => {
       await result.current.handleSubmit();
     });

     const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
     expect(assistantMsg).toBeDefined();
     expect(assistantMsg?.content).toBe('Hello');
   });
   ```

3. **"creates assistant message on first tool_call_start"**:

   ```typescript
   it('creates assistant message on first tool_call_start', async () => {
     const sendMessage = createSendMessageMock([
       {
         type: 'tool_call_start',
         data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' },
       } as StreamEvent,
       { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
     ]);
     const transport = createMockTransport({ sendMessage });
     const { result } = renderHook(() => useChatSession('s1'), {
       wrapper: createWrapper(transport),
     });

     await waitFor(() => expect(result.current.status).toBe('idle'));

     await act(async () => {
       result.current.setInput('Read file');
     });
     await act(async () => {
       await result.current.handleSubmit();
     });

     const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
     expect(assistantMsg).toBeDefined();
     expect(assistantMsg?.toolCalls).toHaveLength(1);
   });
   ```

4. **"does not create duplicate assistant messages on subsequent events"**:

   ```typescript
   it('does not create duplicate assistant messages on subsequent events', async () => {
     const sendMessage = createSendMessageMock([
       { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent,
       { type: 'text_delta', data: { text: 'World' } } as StreamEvent,
       { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
     ]);
     const transport = createMockTransport({ sendMessage });
     const { result } = renderHook(() => useChatSession('s1'), {
       wrapper: createWrapper(transport),
     });

     await waitFor(() => expect(result.current.status).toBe('idle'));

     await act(async () => {
       result.current.setInput('Hi');
     });
     await act(async () => {
       await result.current.handleSubmit();
     });

     const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
     expect(assistantMessages).toHaveLength(1);
     expect(assistantMessages[0].content).toBe('Hello World');
   });
   ```

5. **"handles done without content gracefully"**:

   ```typescript
   it('handles done without content gracefully', async () => {
     const sendMessage = createSendMessageMock([
       { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
     ]);
     const transport = createMockTransport({ sendMessage });
     const { result } = renderHook(() => useChatSession('s1'), {
       wrapper: createWrapper(transport),
     });

     await waitFor(() => expect(result.current.status).toBe('idle'));

     await act(async () => {
       result.current.setInput('test');
     });
     await act(async () => {
       await result.current.handleSubmit();
     });

     // Only user message exists — no assistant message created
     expect(result.current.messages).toHaveLength(1);
     expect(result.current.messages[0].role).toBe('user');
     expect(result.current.status).toBe('idle');
   });
   ```

**Existing tests to update**:

- **"adds user message on submit and clears input"**: Currently expects `messages.toHaveLength(2)` after a `done`-only stream. Update to expect `toHaveLength(1)` (only user message) since `done` without content no longer creates an assistant message.

- **"returns to idle on done events"**: Same issue — update assertion if it checks message count.

- **"appends new messages after history"**: Currently expects 4 messages (2 history + 1 user + 1 assistant). This test sends `text_delta` so the assistant message will still be created. Verify this test still passes as-is.

**Acceptance criteria**:

- All 5 new tests pass
- All existing tests pass (with any necessary updates for deferred creation)
- No test assumes an empty assistant message exists before content events

---

## Phase 2: ResizeObserver Auto-scroll

### Task 2.1: Replace `scrollTrigger` with ResizeObserver in `MessageList.tsx`

**File**: `apps/client/src/components/chat/MessageList.tsx`
**activeForm**: replacing scrollTrigger useEffect with ResizeObserver-based auto-scroll

**Description**:

The current `scrollTrigger` mechanism (lines 127-138) only fires on message count or tool call count changes, missing text delta accumulation, tool card height changes (expansion/collapse animations), and tool call status transitions. Replace it with a ResizeObserver that detects all height changes in the content container.

**Implementation steps**:

1. Add new refs after `isAtBottomRef` (line 52):

   ```typescript
   const contentRef = useRef<HTMLDivElement>(null);
   const rafIdRef = useRef<number>(0);
   ```

2. **Remove** the `scrollTrigger` variable and its `useEffect` (lines 127-138):

   ```typescript
   // REMOVE:
   const lastMsg = messages[messages.length - 1];
   const scrollTrigger = `${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`;
   useEffect(() => {
     if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
       virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
     }
   }, [scrollTrigger, virtualizer]);
   ```

3. **Add** the ResizeObserver `useEffect`:

   ```typescript
   useEffect(() => {
     const contentEl = contentRef.current;
     if (!contentEl) return;

     const observer = new ResizeObserver(() => {
       if (isAtBottomRef.current && !isTouchActiveRef.current) {
         cancelAnimationFrame(rafIdRef.current);
         rafIdRef.current = requestAnimationFrame(() => {
           const scrollEl = parentRef.current;
           if (scrollEl) {
             scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
           }
         });
       }
     });

     observer.observe(contentEl);
     return () => {
       observer.disconnect();
       cancelAnimationFrame(rafIdRef.current);
     };
   }, []);
   ```

4. **Add** a message-count-based scroll trigger as a fallback (ResizeObserver may not fire synchronously when a new virtual row appears):

   ```typescript
   useEffect(() => {
     if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
       requestAnimationFrame(() => {
         const scrollEl = parentRef.current;
         if (scrollEl) {
           scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
         }
       });
     }
   }, [messages.length]);
   ```

5. **Update** the `scrollToBottom` imperative method to use native scroll:

   ```typescript
   const scrollToBottom = useCallback(() => {
     const scrollEl = parentRef.current;
     if (scrollEl) {
       scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
     }
   }, []);
   ```

6. **Update** the IntersectionObserver re-show logic (lines 105-125) to use native scroll instead of `virtualizer.scrollToIndex`:
   Change:

   ```typescript
   virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
   ```

   To:

   ```typescript
   const scrollEl = parentRef.current;
   if (scrollEl) {
     scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
   }
   ```

7. **Add** `ref={contentRef}` to the inner content div in the JSX:
   ```tsx
   <div
     ref={contentRef}
     style={{
       height: virtualizer.getTotalSize(),
       position: 'relative',
       width: '100%',
     }}
   >
   ```

**Why native `scrollTop` instead of `virtualizer.scrollToOffset`**: The scroll container's `scrollHeight` includes everything rendered inside it, both the virtualizer items and the InferenceIndicator positioned below them. This naturally accounts for the indicator's height without needing to measure it separately.

**Acceptance criteria**:

- ResizeObserver is attached to the inner content div
- Auto-scroll fires on any content height change (text growth, tool card expansion, status changes)
- InferenceIndicator stays visible during streaming when user is at bottom
- `scrollToBottom` imperative handle uses native scroll
- IntersectionObserver re-show uses native scroll
- No auto-scroll when user has scrolled up (`isAtBottomRef.current === false`)
- Touch scrolling not disrupted (`isTouchActiveRef.current` check preserved)
- `requestAnimationFrame` debounce prevents layout thrashing

---

### Task 2.2: Update `MessageList.test.tsx` with ResizeObserver tests

**File**: `apps/client/src/components/chat/__tests__/MessageList.test.tsx`
**activeForm**: adding unit tests for ResizeObserver-based auto-scroll and native scrollTop

**Description**:

Add tests for the new ResizeObserver scroll mechanism and update the mock setup.

**Mock setup changes**:

1. Add a global `ResizeObserver` mock alongside the existing `IntersectionObserver` mock:

   ```typescript
   let resizeObserverCallback: (() => void) | null = null;
   globalThis.ResizeObserver = vi.fn().mockImplementation((callback: () => void) => {
     resizeObserverCallback = callback;
     return {
       observe: vi.fn(),
       unobserve: vi.fn(),
       disconnect: vi.fn(),
     };
   });
   ```

2. Add `scrollToOffset` to the `@tanstack/react-virtual` mock return value:
   ```typescript
   vi.mock('@tanstack/react-virtual', () => ({
     useVirtualizer: ({ count }: { count: number }) => ({
       getVirtualItems: () =>
         Array.from({ length: count }, (_, i) => ({
           key: `virt-${i}`,
           index: i,
           start: i * 80,
           size: 80,
         })),
       getTotalSize: () => count * 80,
       measureElement: () => {},
       scrollToIndex: () => {},
       scrollToOffset: () => {},
     }),
   }));
   ```

**New tests to add**:

1. **"attaches ResizeObserver to content container"**:

   ```typescript
   it('attaches ResizeObserver to content container', () => {
     const messages: ChatMessage[] = [
       { id: '1', role: 'user', content: 'Test', parts: [{ type: 'text', text: 'Test' }], timestamp: new Date().toISOString() },
     ];
     render(<MessageList sessionId="test-session" messages={messages} />);
     expect(globalThis.ResizeObserver).toHaveBeenCalled();
   });
   ```

2. **"scroll container uses native scrollTop for scrollToBottom"**:
   ```typescript
   it('scroll container uses native scrollTop for scrollToBottom', () => {
     const ref = React.createRef<MessageListHandle>();
     const messages: ChatMessage[] = [
       { id: '1', role: 'user', content: 'Test', parts: [{ type: 'text', text: 'Test' }], timestamp: new Date().toISOString() },
     ];
     render(<MessageList ref={ref} sessionId="test-session" messages={messages} />);
     // Call the imperative scrollToBottom — it should not throw
     expect(() => ref.current?.scrollToBottom()).not.toThrow();
   });
   ```

**Acceptance criteria**:

- ResizeObserver mock is set up globally
- Test verifies ResizeObserver is instantiated when MessageList renders with messages
- Test verifies scrollToBottom imperative method works without error
- All existing MessageList tests continue to pass

---

## Phase 3: Validation

### Task 3.1: Run all tests and verify build

**activeForm**: running full test suite and build to validate all changes

**Description**:

Run the complete test suite and build to ensure no regressions.

**Steps**:

1. Run `npx turbo test -- --run` and verify all tests pass
2. Run `npx turbo build` and verify build succeeds
3. Run `npx turbo typecheck` and verify no type errors

**Acceptance criteria**:

- All tests pass (including new tests from Tasks 1.2 and 2.2)
- Build completes successfully
- No TypeScript errors
- Acceptance criteria from spec Section 15 are met:
  - No empty assistant bubble appears after submitting a message
  - Assistant message renders on first `text_delta` or `tool_call_start`
  - History-loaded messages render normally
  - Auto-scroll works on any content height change
  - InferenceIndicator stays visible during streaming
  - Manual scroll-up disengages auto-scroll
  - Touch scrolling not disrupted
  - Scroll-to-bottom button works correctly

---

## Dependencies

- Task 1.2 depends on Task 1.1 (tests verify the implementation)
- Task 2.2 depends on Task 2.1 (tests verify the implementation)
- Task 3.1 depends on Tasks 1.2 and 2.2 (validation runs after all changes)
- Phase 1 and Phase 2 are independent and can run in parallel
