"""Run a bounded proof/build under the existing workspace's exclusive marker."""
import json
import os
from pathlib import Path
import subprocess
import sys
# Worktrees share the original repository's workspace coordination directory.
common = Path(subprocess.check_output(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True
).strip())
lane = Path(os.environ.get('LOCAL_BROWSER_LANE_FILE', str(
    common.parent.parent / '.workspace' / 'shared-local-heavy-producer.lock'
)))
if not lane.parent.is_dir():
    print('Workspace lane directory is unavailable; set LOCAL_BROWSER_LANE_FILE')
    sys.exit(3)
identity = json.dumps({'pid': os.getpid(), 'scope': sys.argv[1], 'root': os.getcwd()})
try:
    fd = os.open(lane, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print('Shared native lane is occupied')
    sys.exit(3)
owned_inode = os.fstat(fd).st_ino
with os.fdopen(fd, 'w') as marker:
    marker.write(identity)
    marker.flush()
    os.fsync(marker.fileno())
result = subprocess.run(sys.argv[2:])
if lane.exists() and lane.stat().st_ino == owned_inode and lane.read_text() == identity:
    lane.unlink()
sys.exit(result.returncode)
