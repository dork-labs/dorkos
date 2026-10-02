/** Instrument the real client ACK boundary after decode, canvas draw and two animation frames. */
export async function instrumentRenderBoundary(page) {
  await page.evaluate(() => {
    globalThis.measured = { inputAt: 0, acks: [] };
    globalThis.document
      .querySelector('#screen')
      .addEventListener('pointerdown', () => (globalThis.measured.inputAt = performance.now()));
    const fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (url, options) => {
      const receipt = ['/ack', '/frame'].includes(url) ? JSON.parse(options.body).receipt : null;
      if (receipt) {
        const time = performance.now();
        const canvas = globalThis.document.querySelector('#screen');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)),
          (n) => n.toString(16).padStart(2, '0')
        ).join('');
        globalThis.measured.acks.push({ time, hash, receipt });
        if (globalThis.measured.acks.length > 1000) globalThis.measured.acks.shift();
      }
      return fetchOriginal(url, options);
    };
  });
}
