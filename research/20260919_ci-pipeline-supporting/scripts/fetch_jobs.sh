#!/bin/bash
# Fetch job timings for every run id in sample_ids.json (6 in parallel). Read-only.
cd "$(dirname "$0")"; mkdir -p jobs
jq -r '[.S1[], .S2[], .S3[]] | unique | .[]' sample_ids.json | while read id; do
  [[ -s jobs/$id.json ]] || echo $id; done | xargs -P 6 -n 1 ./fetch_one_job.sh
ls jobs | wc -l
