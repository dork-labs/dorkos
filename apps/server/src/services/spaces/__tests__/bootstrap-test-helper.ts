import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool } from 'pg';

type Post = (path: string, body: unknown, cookie: string) => Promise<Response>;

/** Return only cookie name/value pairs emitted by an HTTP response. */
export function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Exercise the production atomic first-host setup and then establish its browser session. */
export async function bootstrapFirstHost(
  post: Post,
  input: {
    secret: string;
    accountName: string;
    email: string;
    password: string;
    communityName: string;
    channelName?: string;
  }
): Promise<{
  cookie: string;
  communityId: string;
  memberId: string;
  channelId: string;
}> {
  const preflight = await post('/api/v1/bootstrap/preflight', { secret: input.secret }, '');
  if (preflight.status !== 200) throw new Error(`Bootstrap preflight failed: ${preflight.status}`);
  const grant = responseCookies(preflight);
  const completed = await post(
    '/api/v1/bootstrap/complete',
    {
      secret: input.secret,
      accountName: input.accountName,
      email: input.email,
      password: input.password,
      communityName: input.communityName,
      channelName: input.channelName ?? 'general',
    },
    grant
  );
  if (completed.status !== 201) throw new Error(`Bootstrap completion failed: ${completed.status}`);
  const result = (await completed.json()) as {
    community: { id: string };
    memberId: string;
    channelId: string;
  };
  const signIn = await post(
    '/api/auth/sign-in/email',
    { email: input.email, password: input.password },
    ''
  );
  if (signIn.status !== 200) throw new Error(`Bootstrap sign-in failed: ${signIn.status}`);
  return {
    cookie: responseCookies(signIn),
    communityId: result.community.id,
    memberId: result.memberId,
    channelId: result.channelId,
  };
}

/** Seed a password account for an existing integration fixture without using admission authority. */
export async function seedCredentialAccount(
  pool: Pool,
  input: { name: string; email: string; password: string }
): Promise<string> {
  const userId = randomUUID();
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)`, [
    userId,
    input.name,
    input.email.toLowerCase(),
  ]);
  await pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId",password)
     VALUES($1,$2,'credential',$2,$3)`,
    [randomUUID(), userId, await hashPassword(input.password)]
  );
  return userId;
}
