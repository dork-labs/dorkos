#!/usr/bin/env bash

set -euo pipefail

tag="$1"
repository="$2"
manifest="$3"
bundle="$4"
signer_workflow="$5"
source_ref="$6"

download_asset() {
  name="$1"
  destination="$2"
  gh release download "$tag" \
    --repo "$repository" \
    --pattern "$name" \
    --dir "$destination"
}

publish_or_reuse_bundle() {
  name="$(basename "$bundle")"
  if gh release upload "$tag" "$bundle" --repo "$repository"; then
    return
  fi

  existing="$(mktemp -d)"
  if ! download_asset "$name" "$existing"; then
    rm -rf "$existing"
    return 1
  fi

  if ! cmp -s "$bundle" "$existing/$name"; then
    if ! gh attestation verify "$manifest" \
      --bundle "$existing/$name" \
      --repo "$repository" \
      --signer-workflow "$signer_workflow" \
      --source-ref "$source_ref"; then
      rm -rf "$existing"
      echo "::error::Release bundle $name exists but does not verify this exact manifest and provenance." >&2
      return 1
    fi
    cp "$existing/$name" "$bundle"
  fi

  rm -rf "$existing"
}

publish_or_verify_manifest() {
  name="$(basename "$manifest")"
  if gh release upload "$tag" "$manifest" --repo "$repository"; then
    return
  fi

  existing="$(mktemp -d)"
  if ! download_asset "$name" "$existing"; then
    rm -rf "$existing"
    return 1
  fi
  if ! cmp -s "$manifest" "$existing/$name"; then
    rm -rf "$existing"
    echo "::error::Release asset $name already maps this version to different bytes; refusing to replace it." >&2
    return 1
  fi
  rm -rf "$existing"
}

# The manifest is the readiness marker. Its verified bundle must already be
# durable before the manifest can become visible.
publish_or_reuse_bundle
publish_or_verify_manifest
