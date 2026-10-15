---
id: 261007-230000
title: Retain pnpm dependency patches in Community image build contexts
kind: hygiene
status: active
actor: agent
gates: [wf.test.community-packaged]
prs: [2673]
ratchet-release: []
field-changes: []
---

PR 2673 run 37697190095, job 113051693822, checked out the test merge of feature be7f4b11 into its base. The Community acceptance image copied the root manifest and lockfile but its deny-all build context omitted the manifest's tracked pnpm patch. The unchanged frozen install failed with ENOENT for patches/@fumadocs__api-docs@0.2.9.patch before any packaged build or browser assertion.

Allow root patches/*.patch in the acceptance and release build contexts. Copy those patches before the release image's existing frozen install, which otherwise has the same source-proven omission. Include root package.json and patches/ changes in the existing PR scope selector: they are actual install inputs. Existing scope fixtures cover both positive inputs and near misses. No required-status, network, retry, worker, timeout, dependency version, package manifest, lockfile or runtime behavior changes.

Check the original packaged proof after the context correction; its result remains pending. Revert or narrow this allowance if it admits files unrelated to the manifest's dependency patches. Existing secret and generated-output exclusions remain.
