# Skills

Skills are reusable playbooks that the agent loads only when they are relevant.
The server exposes `list_skills` for discovery and `read_skill(name)` for the
full instructions.

## Discovery Order

First matching skill name wins:

1. `AGENT_SKILLS_DIR`
2. this repository's `skills/`
3. `<workspace>/.claude/skills/`
4. `<workspace>/.agent/skills/`

## Format

Each skill is a folder with a `SKILL.md` file:

```markdown
---
name: my-skill
description: One line describing when to use this skill.
---

# My Skill

Step-by-step instructions for the agent.
```

Rules:

- `name` must be unique across discovered skills.
- `description` should tell the agent when to use the skill.
- Keep instructions operational and verifiable.
- Do not put secrets, API keys, tunnel IDs, or private customer data in skills.

## Validate

```bash
node scripts/validate-skills.mjs
node scripts/local-coding-agent.mjs skills validate
```

## Shipped Skills

- `setup-local-coding-agent`: install and verify a fresh customer setup.
- `update-local-coding-agent`: safely update an existing customer clone.
- `debug-tunnel-network`: diagnose tunnel, proxy, DNS, TLS, and office-network issues.
- `customer-support`: collect useful customer context without exposing secrets.
- `release-manager`: run release checks, version bumps, tags, GitHub releases, and assets.
- `security-hardening-review`: review changes around file/command/network/approval security.
- `skill-creator`: design and validate new project skills.
- `code-review`: review a git diff for bugs, security issues, and clarity.
