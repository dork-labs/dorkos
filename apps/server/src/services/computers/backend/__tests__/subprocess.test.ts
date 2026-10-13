import { describe, expect, it } from 'vitest';
import { runBounded } from '../subprocess.js';
describe('bounded managed subprocess', () => {
  it('preserves argv literally and does not import host credentials', async () => {
    const result = await runBounded(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify([process.argv[1],process.env.HOME,process.env.ANTHROPIC_API_KEY]))',
        '$(echo not-a-shell)',
      ],
      { env: {}, timeoutMs: 5000 }
    );
    expect(JSON.parse(result.stdout)).toEqual(['$(echo not-a-shell)', null, null]);
  });
  it('kills output overflow instead of buffering indefinitely', async () => {
    await expect(
      runBounded(process.execPath, ['-e', "process.stdout.write('x'.repeat(2*1024*1024))"], {
        env: {},
        timeoutMs: 5000,
      })
    ).rejects.toThrow('output limit');
  });
  it('kills a command exceeding its deadline', async () => {
    await expect(
      runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, timeoutMs: 20 })
    ).rejects.toThrow('deadline');
  });
});
