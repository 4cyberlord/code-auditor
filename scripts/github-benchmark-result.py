#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


job_id, language, runtime, status, duration_ms, artifact_key, stdout_path, stderr_path = sys.argv[1:9]
stdout = Path(stdout_path).read_text(errors="replace")
stderr = Path(stderr_path).read_text(errors="replace")

metrics = {}
for line in stderr.splitlines():
    if not line.startswith("CA_METRICS "):
        continue
    for part in line[len("CA_METRICS ") :].split():
        if "=" in part:
            key, value = part.split("=", 1)
            metrics[key] = value


def count(label, text):
    return len(re.findall(rf"^\s*{label}\b", text, flags=re.MULTILINE | re.IGNORECASE))


result = {
    "jobId": job_id,
    "language": language,
    "runtime": runtime,
    "artifactKey": artifact_key or None,
    "ok": int(status) == 0,
    "exitCode": int(status),
    "durationMs": int(duration_ms),
    "remoteElapsedMs": round(float(metrics["elapsed_s"]) * 1000) if metrics.get("elapsed_s") else None,
    "peakMemoryKb": int(metrics["maxrss_kb"]) if metrics.get("maxrss_kb", "").isdigit() else None,
    "passed": count("PASS", stdout),
    "failed": count("FAIL", stdout),
    "stdout": stdout[-64000:],
    "stderr": stderr[-64000:],
}

print(json.dumps(result, indent=2))
