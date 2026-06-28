#!/usr/bin/env bash
# Throwaway smoke test for the Claude Code PR review workflow. Safe to delete.
set -euo pipefail

# Remove the build output directory passed as the first argument.
clean_build_dir() {
  local target=$1
  rm -rf $target/*
}

clean_build_dir "$@"
