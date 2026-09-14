import landscapeUrl from './markdown-landscape.svg?url';

/** A bundled image keeps visual checks independent of remote image hosts. */
export const MARKDOWN_IMAGE_SAMPLE = `![1](${landscapeUrl} "A quiet landscape, with room to think.")`;

/** Formatting corpus shared by the real canvas showcases. */
export const MARKDOWN_READING_SAMPLE = `# A clearer place to think

A well-made document gives every idea room to breathe. Use **strong words**, *a quiet emphasis*, ~~an old thought~~, and \`inline code\` when each earns its place.

[Read the DorkOS guide](https://dorkos.ai/docs) or keep writing here. Two spaces give this sentence a soft break.${'  '}
The next thought stays in the same paragraph.

## Bring order to the details

- One bullet per thought
- A second thought with **emphasis**
  - A nested detail
  - Another detail
    1. A deeper numbered step
    2. Its companion
- Return to the main idea

3. Start where the last list ended
4. Refine the words
5. Share when ready

- [ ] Review the draft
- [x] Find a clear title
- [ ] Keep the details together
  - [x] Check the nested task

### Let a longer thought breathe

- A list item can have two paragraphs.

  This second paragraph belongs to the same idea, with enough space to show the relationship.

- A new item starts here.

> Clear writing is clear thinking.
>
> A second paragraph can carry **emphasis** and a [useful link](https://dorkos.ai).

#### Details without distraction

A fourth-level heading still has a place in a longer document.

##### The smaller point

Use the next level only when the structure needs it.

###### A final detail

Small headings remain distinct from the text below them.

---

## A picture with a purpose

${MARKDOWN_IMAGE_SAMPLE}

## Code that reads like code

\`\`\`typescript
// A small idea, expressed clearly.
export function greet(name: string): string {
  const visits = 42;
  return \`Hello, \${name}. Visit \${visits}.\`;
}
\`\`\`

## Compare the choices

| Element | Purpose | State |
| :--- | :---: | ---: |
| **Heading** | Structure | Ready |
| Paragraph | Voice | Draft |
| \`Code\` | Precision | Ready |

Math stays readable inline, $E = mc^2$, and on its own:

\`\`\`latex
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
\`\`\`
`;

/** Long lines and a wide table exercise narrow workbench panels. */
export const MARKDOWN_NARROW_SAMPLE = `## Notes in a narrow panel

This document should fit a phone or a narrow canvas without losing the thread of a sentence.

- A thought with enough words to wrap onto a second line while its bullet stays aligned with the first.
  - A nested thought that wraps too, keeping its relationship clear.

A long identifier: \`workspace_document_revision_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789\`.

[https://example.com/a/very/long/path/that/should/wrap/without/pushing/the/document/off/the/screen](https://example.com)

\`\`\`typescript
const longLine = "Code keeps its indentation and scrolls horizontally inside its own surface, even in the narrowest panel.";
\`\`\`

| A longer column heading | Another detailed column | Final column |
| --- | --- | --- |
| A useful comparison | A longer description that wraps | Ready to review |
`;

/** Frontmatter is a separate block, never typography for the document body. */
export const MARKDOWN_FRONTMATTER_SAMPLE = `---
title: A field guide
status: draft
tags:
  - design
  - writing
---

# The document starts here

Metadata remains separate from the text you came to read.
`;
