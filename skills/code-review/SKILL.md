---
name: code-review
description: Review the current git diff for bugs, security issues, and clarity, then summarize findings by severity.
---

# Code Review

Use this when the user asks to review changes, a pull request, or "what did I
break".

## Steps

1. Scope the change with `git diff --stat` and then read the actual diff with
   `git diff`.
2. Prefer reviewing the diff over reading entire files. Use `read_many` only
   for files whose full context is needed.
3. Review in this order:
   - Correctness: logic bugs, edge cases, null/undefined, async misuse, error handling.
   - Security: injection, secrets, missing validation, unsafe file/command behavior.
   - Maintainability: naming, dead code, duplication, missing tests.
4. Do not pad the review with speculative nits. If uncertain, say what evidence
   would confirm the issue.

## Output

Group findings by severity:

- Blocking: must fix before merge, with file/line and a concrete fix.
- Should fix: important but not necessarily blocking.
- Nit: optional polish.

End with a short verdict: safe to merge, needs work, or blocked pending evidence.
