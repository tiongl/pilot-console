# npm Release Setup

**Status**: Not Started

## Summary

Publish `@tionglee/clippy` to public npmjs.com with GitHub Actions CI/CD for automated releases on version tags.

## Tasks

### 1. Update package.json
- Rename to `@tionglee/clippy`
- Add `publishConfig: { access: "public" }`
- Add `files` field: `bin/`, `src/`, `dist/`, `public/`
- Add `prepublishOnly` script: `npm run build`
- Add `engines`, `description`, `repository`, `license`, `keywords`

### 2. Create .npmignore
- Exclude: tests, dev configs, docs/todo, `.env*`, coverage, `.github/`

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
npm install -g @tionglee/clippy
clippy
```

## File Changes

| File | Change |
|------|--------|
| `package.json` | Add npm publishing fields |
| `.npmignore` | New — exclude dev/test files |
| `.github/workflows/release.yml` | New — CI/CD publish workflow |

## Notes

- `clippy` name is taken on npmjs — using scoped `@tionglee/clippy`
- Package includes pre-built client assets in `dist/`
- Native deps (better-sqlite3, node-pty) are installed at user's `npm install` time
