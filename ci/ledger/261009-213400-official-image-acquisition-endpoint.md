---
id: 261009-213400
title: Acquire the same official container images without Docker Hub auth outages
kind: incident-fix
status: active
actor: agent
gates:
  - wf.test.community-pg
  - wf.test.community-packaged
  - wf.cli-smoke-test.smoke-test-docker
  - wf.cli-smoke-test.integration-test
prs:
  - 2673
hypothesis:
  metric: gate.wf.test.community-pg.failure_rate@pull_request
  baseline: 0.09302325581395349
  baseline_source: 'ci-steward-data@fb415dccaa73e31652d563ae910a0194cf34d841 latest.json dated2026-10-08 collected2026-10-09T11:46:28.623Z points to snapshots/2026-10-08.json; wf.test.community-pg@pull_request conclusions: 4 failure / 43 completed noncancelled (39 success); 5 cancelled excluded. Complete, nontruncated GitHub population. Collector health is false for a stale local-export clone; no missing GitHub gate population is reported.'
  target: 0.025
  after_days: 7
ratchet-release: []
field-changes: []
---

Published a47's community PostgreSQL and packaged jobs and both CLI Docker legs
failed before entering product assertions with Docker Hub HTTP429. The once-only
failed CLI retry reproduced the same acquisition failure. Fresh published394089
failed those four legs again: PostgreSQL's auth.docker.io token GET timed out
across the runner's three existing retries; the three Node builds received
HTTP504 from the token POST. The current failures are not literal429 and do not
establish a product regression. Their full original negative logs are retained.

Change only the image registry hostname to Docker's official repositories on
Amazon ECR Public. Keep postgres:17-alpine, node:24-bookworm-slim and the CLI's
node:${NODE_VERSION}-slim selection, with the existing NODE_VERSION=24 default.
The real service container and packaged host pull/run select the official
PostgreSQL copy; the acceptance and CLI Dockerfile FROMs select official Node
copies. Both CLI build targets inherit that base. No login, account, paid
provider, extra retry, cache bypass, fallback mirror or new build argument is
introduced. No test filters, assertions, deadlines, health checks, isolated
network controls, build/install commands, required statuses or event legs change.

Read-only RegistryV2 observations authenticated byte-identical Docker Hub and
ECR Public OCI indexes for all three current tags. PostgreSQL index SHA256 is
b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24.
Both Node tags currently resolve to index SHA256
d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20.
Linux amd64 child manifests and configs were fetched from both registries and
verified by their content digests, with identical layer digest/size/media-type
lists and rootfs diff IDs. No layer payload was downloaded and no Docker build
or runtime proof is claimed. Existing version tags remain tags; this is not a
new digest-pinning policy. Fresh CI must prove full acquisition and unchanged
product checks, and future official tag updates remain subject to those checks.

AWS documents Docker's verified official publisher and anonymous public pulls:
https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/
https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html

Retain or revert based on fresh complete CI and the seven-day metric. Revert or
revise if ECR acquisition fails persistently, the official image variants drift
from their Docker Hub counterpart, or failure rate does not reach 0.025. An
acquisition success is not a product success; the original product gates remain
authoritative. The collector's stale local-export limitation is not repaired by
this change and no aggregate quality success is asserted before measurement.
