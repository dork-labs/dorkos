import express from 'express';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import files from '../../../../../routes/files.js';
import { authorityFixture } from './authority-fixtures.js';
import { setRoomService, clearRoomService } from '../../../../rooms/index.js';
import { saveRecognizedNormalFileService } from '../normal-file-save.js';

const target = swappableServer();

// Real native installation/canonical writer, with no fake file service or policy registrar.
describe('original installed ordinary file route', () => {
  it('uses the captured normal writer for changed/no-op/conflict and refuses a stopped owner', async () => {
    const h = await authorityFixture();
    setRoomService(h.rooms.service);
    const app = express();
    app.use(express.json());
    app.locals.docChannelHttp = h.http;
    let directFailure: { cause: unknown } | undefined;
    app.put('/original-save-cause', async (req, res) => {
      try {
        const result = await saveRecognizedNormalFileService(
          h.http.normalFileSave,
          req,
          res,
          req.body
        );
        res.status('code' in result ? 409 : 200).json(result);
      } catch (cause) {
        directFailure = { cause };
        res.status(500).end();
      }
    });
    app.use('/files', files);
    const server = target.mount(app);
    try {
      h.http.normalFileSave.saveHttp = () => {
        throw new Error('Reflected ordinary save used');
      };
      const original = await fs.readFile(h.path, 'utf8');
      // A genuine same-byte original request exposes only its retained raw fixture cause.
      // It performs no write and does not replace any public method or production guard.
      const direct = await request(server)
        .put('/original-save-cause')
        .send({ cwd: h.dir, path: 'tasks.md', content: original, expectedContent: original });
      if (directFailure) throw directFailure.cause;
      expect(direct.status).toBe(200);
      expect(direct.body).toMatchObject({ ok: true, effect: 'no_op' });
      const content = original + 'saved through original owner\n';
      const changed = await request(server)
        .put('/files/content')
        .send({ cwd: h.dir, path: 'tasks.md', content, expectedContent: original });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ ok: true, effect: 'changed' });
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
      const unchanged = await request(server)
        .put('/files/content')
        .send({ cwd: h.dir, path: 'tasks.md', content, expectedHash: changed.body.hash });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body).toMatchObject({ ok: true, effect: 'no_op', hash: changed.body.hash });
      const conflict = await request(server)
        .put('/files/content')
        .send({ cwd: h.dir, path: 'tasks.md', content: original, expectedContent: original });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        code: 'CONFLICT',
        currentContent: content,
        currentHash: changed.body.hash,
      });
      await h.http.stopFileWrites();
      const stopped = await request(server)
        .put('/files/content')
        .send({ cwd: h.dir, path: 'tasks.md', content: original, expectedHash: changed.body.hash });
      expect(stopped.status).toBe(500);
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
    } finally {
      try {
        await h.cleanup();
      } finally {
        clearRoomService(h.rooms.service);
      }
    }
  });
});
