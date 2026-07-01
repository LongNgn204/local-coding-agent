---
name: skill-creator
description: Create or improve Local Coding Agent skills with valid frontmatter, clear trigger conditions, and validation checks.
---

# Skill Creator

Use this when the user wants to create a new reusable skill or improve an
existing one.

## Skill Rules

- One folder per skill.
- `SKILL.md` must contain YAML frontmatter with `name` and `description`.
- Keep the name short, lowercase, and unique.
- The description must explain when an agent should use the skill.
- Put operational steps in the body.
- Avoid secrets, customer data, and huge pasted logs.

## Template

```markdown
---
name: example-skill
description: Use this when ...
---

# Example Skill

## Rules

- ...

## Steps

1. ...

## Output

- ...
```

## After Creating

Run:

```bash
node scripts/validate-skills.mjs
```
