# npm Release Setup

**Status**: In Progress

## Summary

Publish `pilot-console` to public npmjs.com with GitHub Actions CI/CD for automated releases on version tags.

## Tasks

### 1. Update package.json
- Done: verified name is `pilot-console`
- Done: added `publishConfig: { access: "public" }`
- Done: added `files` field for `bin/`, `src/`, `dist/`, and `public/pilot-console-logo.svg`
- Done: added `prepublishOnly` script: `npm run build`
- Done: added `engines`, `description`, `repository`, `license`, `keywords`

### 2. Create .npmignore
- Done: excludes tests, dev configs, docs/todo, `.env*`, coverage, `.github/`

### 3. Create GitHub Actions release workflow
- File: `.github/workflows/release.yml`
- Trigger on version tags (`v*`)
- Steps: checkout → Node setup → install → build → test → npm publish
- Requires `NPM_TOKEN` repo secret

### 4. Add release convenience script
- `npm run release` — bumps patch version, creates git tag, pushes to trigger CI

## Usage After Setup

```bash
# One-time: set NPM_TOKEN in GitHub repo settings → Secrets
npm run release              # bump patch, tag, push → CI publishes
npm version minor && git push --follow-tags  # bump minor manually

# Users install with:
npm install -g pilot-console
pilot-console
```

## File Changes

| File | Change |
|------|--------|
| `package.json` | Added npm publishing fields |
| `.npmignore` | New — exclude dev/test files |
| `.github/workflows/release.yml` | New — CI/CD publish workflow |

## Notes

- Package includes pre-built client assets in `dist/`
- Native deps (better-sqlite3, node-pty) are installed at user's `npm install` time
