/* global console, fetch, process, URL */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONTEXT = 'security-review';

/** The workflow is the sole security-path list, shared by both read-only tools. */
export function securityPathPattern() {
  const text = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
  const pattern = /^ {2}SECURITY_PATH_PATTERN: '(.+)'$/m.exec(text)?.[1];
  if (!pattern) throw new Error('Security path list missing');
  return pattern;
}

/** GitHub returns statuses newest first. An older success never overrides a refusal. */
export function latestReview(statuses) {
  return statuses.find((status) => status.context === CONTEXT);
}

// Match marketplace S3b's expansion fold in addition to RegExp's simple Unicode
// fold (notably sharp-s -> ss). Keep the original path: folding only adds matches.
function fullFold(path) {
  return path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

export function touchesSecurity(files, pattern) {
  const exact = new RegExp(pattern);
  const matcher = new RegExp(pattern, 'iu');
  return files.some((file) =>
    [file.filename, file.previous_filename].some(
      (path) =>
        path &&
        // Flags can remove matches for lookaheads and negated classes. Preserve
        // the original flagless verdict before adding folded matches.
        (exact.test(path) ||
          [path, fullFold(path), fullFold(path.normalize('NFKC'))].some((form) =>
            matcher.test(form)
          ))
    )
  );
}

/** Walk the queue's commit chain, rather than trusting the PR number in its ref.
 * A cumulative group includes earlier entries, even with a one-PR merge limit.
 * Missing/dequeued/rebuilt entries fail closed instead of approving an old group.
 */
export function groupMembers(entries, group) {
  const members = [];
  const seen = new Set();
  let head = group.head_sha;
  while (head !== group.base_sha) {
    if (seen.has(head)) throw new Error('Cycle in merge queue');
    seen.add(head);
    const matches = entries.filter((entry) => entry.headCommit?.oid === head);
    if (matches.length !== 1) throw new Error(`Cannot resolve queued commit ${head}`);
    const entry = matches[0];
    if (!entry.pullRequest?.headRefOid || !entry.baseCommit?.oid)
      throw new Error('Incomplete queue entry');
    members.unshift(entry);
    head = entry.baseCommit.oid;
  }
  if (!members.length) throw new Error('Empty merge group');
  return members;
}

function hasApproval(review, sensitive, botUserId) {
  if (review?.state !== 'success') return false;
  // Preserve the trusted initializer's automatic classification, never a user's
  // imitation. Sensitive approvals always require the dedicated App.
  if (!sensitive && review.description === 'no security paths')
    return review.creator?.login === 'github-actions[bot]';
  return Boolean(
    Number.isSafeInteger(Number(botUserId)) &&
    Number(botUserId) > 0 &&
    review.creator?.id === Number(botUserId) &&
    review.description !== 'no security paths'
  );
}

function validateFiles(files) {
  if (
    !Array.isArray(files) ||
    files.some(
      (file) =>
        !file ||
        typeof file.filename !== 'string' ||
        !file.filename ||
        (file.previous_filename !== undefined && typeof file.previous_filename !== 'string')
    ) ||
    new Set(files.map((file) => file.filename)).size !== files.length
  )
    throw new Error('Incomplete or invalid file list');
  return files;
}

async function sensitiveDiff(api, number, pr, pattern) {
  if (!pattern) throw new Error('Security path list missing');
  const files = await api.files(number);
  // The files endpoint is capped at 3,000; never classify a truncated diff as safe.
  if (
    !Number.isSafeInteger(pr.changed_files) ||
    pr.changed_files < 0 ||
    pr.changed_files >= 3000 ||
    validateFiles(files).length !== pr.changed_files
  )
    throw new Error('Incomplete PR file list');
  return touchesSecurity(files, pattern);
}

export async function checkPullRequest(
  api,
  event,
  pattern,
  { write = false, requireApproval = true, botUserId } = {}
) {
  const number = event.pull_request.number;
  const sha = event.pull_request.head.sha;
  const pr = await api.pr(number);
  if (pr.head.sha !== sha) throw new Error(`PR #${number} head moved`);
  const sensitive = await sensitiveDiff(api, number, pr, pattern);
  let review = latestReview(await api.statuses(sha));
  if (write && (!sensitive || !hasApproval(review, sensitive, botUserId))) {
    const state = sensitive ? 'pending' : 'success';
    if (
      review?.state !== state ||
      (!sensitive &&
        (review?.description !== 'no security paths' ||
          review?.creator?.login !== 'github-actions[bot]'))
    ) {
      review = await api.setStatus(
        sha,
        state,
        sensitive ? 'Security approval required for this SHA' : 'no security paths'
      );
    }
  }
  if (write) await audit(api, number, sha, review);
  const current = await api.pr(number);
  if (current.head.sha !== sha) throw new Error(`PR #${number} head moved`);
  if (current.base.ref !== pr.base.ref || current.base.sha !== pr.base.sha)
    throw new Error(`PR #${number} base moved`);
  // Only ABSENT status permits computed clearance. Never bypass an explicit
  // pending/failure (or reused automatic approval on a now-sensitive diff).
  const computed = !write && !review && !sensitive;
  if (requireApproval && !computed && !hasApproval(review, sensitive, botUserId))
    throw new Error(
      `PR #${number}: security-review pending on ${sha}; Security must approve, then rerun security-gate`
    );
  return computed ? 'no security paths (computed)' : 'Security status verified';
}

async function queuedSensitiveDiff(api, base, sha, pattern) {
  if (!base || !sha || !pattern) throw new Error('Missing immutable comparison input');
  const comparison = await api.compare(base, sha);
  // Compare files appear only on page 1 and are capped at 300, independently
  // of commit pagination. At the cap completeness is unknown, so refuse.
  const files = validateFiles(comparison.files);
  if (
    comparison.base_commit?.sha !== base ||
    comparison.merge_base_commit?.sha !== base ||
    files.length >= 300
  )
    throw new Error('Incomplete queued-head comparison');
  return touchesSecurity(files, pattern);
}

async function audit(api, number, sha, review) {
  // The creator is the status author, NOT the person who triggered this run.
  const marker = `<!-- security-gate:${sha}:${review?.state ?? 'missing'} -->`;
  const prefix = `<!-- security-gate:${sha}:`;
  const previous = (await api.comments(number))
    .filter(
      (comment) => comment.user?.login === 'github-actions[bot]' && comment.body.includes(prefix)
    )
    .at(-1);
  if (previous?.body.includes(marker)) return;
  await api.comment(
    number,
    `Security gate: \`${CONTEXT} = ${review?.state ?? 'missing'}\` on \`${sha}\`, set by @${review?.creator?.login ?? 'unknown'}. Status id: ${review?.id ?? 'unknown'}.\n${marker}\n\nSensitive approvals require the configured Security App as status creator. The security-reviewed label is a human signal only.`
  );
}

export async function checkMergeGroup(api, event, pattern, botUserId) {
  const group = event.merge_group;
  const members = groupMembers(await api.queue(group.base_ref), group);
  const results = [];
  for (const entry of members) {
    const { number, headRefOid: sha } = entry.pullRequest;
    const pr = await api.pr(number);
    if (pr.base.ref !== group.base_ref.replace(/^refs\/heads\//, ''))
      throw new Error(`PR #${number} base moved`);
    // Never borrow the current PR's files for the queued commit. Both SHA
    // arguments are pinned by the merge-group event/entry snapshot.
    const sensitive = await queuedSensitiveDiff(
      api,
      entry.baseCommit.oid,
      entry.headCommit.oid,
      pattern
    );
    const review = latestReview(await api.statuses(sha));
    const computed = !review && !sensitive;
    if (!computed && !hasApproval(review, sensitive, botUserId))
      throw new Error(
        `PR #${number}: no security-review success on ${sha}; pending Security approval`
      );
    const current = await api.pr(number);
    if (pr.head.sha !== sha || current.head.sha !== sha)
      throw new Error(`PR #${number} head moved`);
    if (current.base.ref !== pr.base.ref || current.base.sha !== pr.base.sha)
      throw new Error(`PR #${number} base moved`);
    results.push(
      `PR #${number}: ${computed ? 'no security paths (computed)' : 'Security status verified'}`
    );
  }
  // A push can dequeue/rebuild an entry while statuses are being read.
  const current = groupMembers(await api.queue(group.base_ref), group);
  if (JSON.stringify(current) !== JSON.stringify(members))
    throw new Error('Merge queue changed during security review');
  return results.join('\n');
}

/** Minimal GitHub client. Follow every page; API errors never become empty results. */
export function githubApi(repository, token, apiUrl = 'https://api.github.com') {
  const root = `${apiUrl}/repos/${repository}`;
  async function request(url, body) {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} at ${new URL(url).pathname}`);
    return {
      data: await response.json(),
      next: /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1],
    };
  }
  async function pages(path) {
    const values = [];
    const seen = new Set();
    let url = `${root}${path}?per_page=100`;
    while (url) {
      if (seen.has(url)) throw new Error('Repeated pagination cursor');
      seen.add(url);
      const result = await request(url);
      if (!Array.isArray(result.data)) throw new Error('Incomplete GitHub list response');
      values.push(...result.data);
      url = result.next;
    }
    return values;
  }
  return {
    pr: async (number) => (await request(`${root}/pulls/${number}`)).data,
    files: (number) => pages(`/pulls/${number}/files`),
    compare: async (base, sha) =>
      (
        await request(
          `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(sha)}?per_page=1&page=1`
        )
      ).data,
    statuses: (sha) => pages(`/commits/${sha}/statuses`),
    setStatus: async (sha, state, description) =>
      (await request(`${root}/statuses/${sha}`, { context: CONTEXT, state, description })).data,
    comments: (number) => pages(`/issues/${number}/comments`),
    comment: (number, body) => request(`${root}/issues/${number}/comments`, { body }),
    async queue(baseRef) {
      const [owner, name] = repository.split('/');
      const entries = [];
      let after = null;
      do {
        const { data: result } = await request(`${apiUrl}/graphql`, {
          query: `query($owner:String!,$name:String!,$branch:String!,$after:String) {
            repository(owner:$owner,name:$name) { mergeQueue(branch:$branch) {
              entries(first:100,after:$after) { nodes {
                baseCommit { oid } headCommit { oid } pullRequest { number headRefOid }
              } pageInfo { hasNextPage endCursor } }
            } }
          }`,
          variables: { owner, name, branch: baseRef.replace(/^refs\/heads\//, ''), after },
        });
        if (result.errors) throw new Error('GitHub merge queue query failed');
        const page = result.data?.repository?.mergeQueue?.entries;
        if (!page) throw new Error('Merge queue unavailable');
        entries.push(...page.nodes);
        if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
          throw new Error('Missing queue cursor');
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return entries;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const api = githubApi(
      process.env.GITHUB_REPOSITORY,
      process.env.GH_TOKEN,
      process.env.GITHUB_API_URL
    );
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      if (!process.env.SECURITY_PATH_PATTERN) throw new Error('Security path list missing');
      console.log(
        await checkPullRequest(api, event, process.env.SECURITY_PATH_PATTERN, {
          botUserId: process.env.SECURITY_APPROVAL_BOT_USER_ID,
        })
      );
    } else if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
      // This event checks out ONLY the trusted base SHA, never PR code.
      // This writer has its own workflow, never the required verifier's identity.
      if (process.env.SECURITY_GATE_MODE === 'initialize') {
        const pattern = securityPathPattern();
        const trustedWorkflow = readFileSync(
          new URL('../workflows/security-gate.yml', import.meta.url),
          'utf8'
        );
        await checkPullRequest(api, event, pattern, {
          write: true,
          requireApproval: false,
          botUserId: /^ {2}SECURITY_APPROVAL_BOT_USER_ID: '([^']+)'$/m.exec(trustedWorkflow)?.[1],
        });
      } else {
        throw new Error('Target event requires explicit initializer mode');
      }
    } else if (process.env.GITHUB_EVENT_NAME === 'merge_group') {
      console.log(
        await checkMergeGroup(
          api,
          event,
          process.env.SECURITY_PATH_PATTERN,
          process.env.SECURITY_APPROVAL_BOT_USER_ID
        )
      );
    } else {
      throw new Error('Unsupported security gate event');
    }
    console.log('Security gate passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
