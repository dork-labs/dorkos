/**
 * The lightbox every picture in a message opens, benched inside a REAL message
 * row: the gallery lives in `Message.Root`, so a row is the only honest place
 * to show next and previous working across a Markdown picture and two
 * attachments.
 *
 * @module dev/showcases/ImageLightboxShowcases
 */
import { Conversation, Message } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import { ImageLightboxTrigger, MarkdownContent } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AGENT_AUTHOR } from '../mock-chat-data';
// `?no-inline`: a small asset would otherwise arrive as a `data:` URL, which
// Markdown refuses as a picture address.
import landscapeUrl from '../mock-samples/markdown-landscape.svg?no-inline';
import portraitUrl from '../mock-samples/lightbox-portrait.svg?url';
import squareUrl from '../mock-samples/lightbox-square.svg?url';

const AT = '2026-10-16T09:45:00.000Z';
/** `Message.Root`'s voice. Named apart because `jsx-a11y` reads a literal `role=` as ARIA. */
const VOICE = 'assistant' as const;

/** A verified image attachment, the way a room message carries one. */
function imageAttachment(id: string, name: string, url: string): RoomAttachment {
  return { id, name, url, mimeType: 'image/svg+xml', size: 2_048, preview: 'image' };
}

const ATTACHMENTS: RoomAttachment[] = [
  imageAttachment('lb-portrait', 'evening-ridge.svg', portraitUrl),
  imageAttachment('lb-square', 'landing-draft.svg', squareUrl),
];

// Absolute, because Markdown refuses a relative picture address too.
const BODY = `Here is the first pass at the landing page, with the two references you sent.

![A quiet landscape, with room to think](${new URL(landscapeUrl, window.location.origin).href})`;

/** Every lightbox section, in page order. */
export function ImageLightboxShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Image lightbox"
        description="Click any picture to open it over the page. Every picture in one message is one gallery: arrows or ← → step through them, Escape or a click outside closes, and focus returns to the picture you were on. On a phone: pinch to zoom, swipe sideways to step, drag down to close."
      >
        <ShowcaseLabel>A message with a Markdown picture and two attachments</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
            <Message.Root role={VOICE} position="only">
              <Message.Gutter author={AGENT_AUTHOR} at={AT} />
              <Message.Body>
                <Message.Author author={AGENT_AUTHOR} at={AT} />
                <Message.Content>
                  <MarkdownContent content={BODY} />
                </Message.Content>
                <Message.Attachments items={ATTACHMENTS} />
              </Message.Body>
            </Message.Root>
          </Conversation.Root>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Image lightbox states"
        description="A picture outside any message is a gallery of one, with no counter or arrows. A picture that will not load says so in the viewer instead of showing an empty frame."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>On its own</ShowcaseLabel>
            <ShowcaseDemo>
              <ImageLightboxTrigger
                image={{ src: squareUrl, alt: 'A landing page draft' }}
                className="block"
              >
                <img
                  src={squareUrl}
                  alt="A landing page draft"
                  className="max-h-48 rounded-md border"
                />
              </ImageLightboxTrigger>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Fails to load</ShowcaseLabel>
            <ShowcaseDemo>
              <ImageLightboxTrigger
                image={{ src: '/missing/picture.png', alt: 'A picture that is gone' }}
                className="bg-muted text-muted-foreground block rounded-md px-4 py-10 text-sm"
              >
                Open a missing picture
              </ImageLightboxTrigger>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>
    </>
  );
}
