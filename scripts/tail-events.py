"""Summarises a `wrangler tail --format json` capture for the findings.

Capture first:
    npx wrangler tail jigworks --format json > .wrangler/tail.jsonl
Then:
    python3 -I scripts/tail-events.py .wrangler/tail.jsonl [event ...]

Prints each platform log line whose `event` is one of those given (default:
check, check-request, build, build-request, turn), with the time, the
invocation it came from, and that invocation's CPU and wall time from
Cloudflare's trace. A `turn` line also gets an estimated cost at Opus 5.5's
prices. The capture holds JSON objects one after another, with wrangler's own
warnings, such as "Tail connection lost", between them; those are skipped.
"""

import json
import re
import sys
import time

# Opus 5.5, dollars per million tokens.
INPUT, CACHE_WRITE, CACHE_READ, OUTPUT = 4, 5, 0.2, 20


def events(path):
    """Each tail event in the capture, skipping anything that isn't JSON."""
    decoder = json.JSONDecoder()
    text = open(path, encoding="utf8").read()
    i = 0
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        try:
            event, i = decoder.raw_decode(text, i)
            yield event
        except json.JSONDecodeError:
            next_object = re.compile(r"^\{", re.M).search(text, i + 1)
            if not next_object:
                break
            i = next_object.start()


def platform_logs(event):
    """The platform's own JSON log lines in an event."""
    for line in event.get("logs", []):
        message = line.get("message")
        message = message[0] if isinstance(message, list) else message
        if isinstance(message, str) and message.startswith("{"):
            try:
                yield json.loads(message)
            except json.JSONDecodeError:
                pass


def turn_cost(log):
    uncached = log["inputTokens"] - log["cacheReadTokens"] - log["cacheWriteTokens"]
    dollars = (
        uncached * INPUT
        + log["cacheWriteTokens"] * CACHE_WRITE
        + log["cacheReadTokens"] * CACHE_READ
        + log["outputTokens"] * OUTPUT
    ) / 1e6
    return round(dollars, 3)


def main():
    path = sys.argv[1]
    wanted = set(sys.argv[2:]) or {"check", "check-request", "build", "build-request", "turn"}
    total = 0.0
    for event in events(path):
        detail = event.get("event") or {}
        source = detail.get("rpcMethod") or (detail.get("request") or {}).get("method") or ",".join(list(detail)[:1])
        for log in platform_logs(event):
            if log.get("event") not in wanted:
                continue
            when = time.strftime("%H:%M:%S", time.localtime(event.get("eventTimestamp", 0) / 1000))
            where = f"{event.get('entrypoint') or 'fetch'} {source}"
            extra = ""
            if log["event"] == "turn" and "inputTokens" in log:
                cost = turn_cost(log)
                total += cost
                extra = f" ${cost}"
            print(when, where, "cpu", event.get("cpuTime"), "wall", event.get("wallTime"), json.dumps(log) + extra)
    if total:
        print(f"Turns cost about ${round(total, 2)}")


if __name__ == "__main__":
    main()
