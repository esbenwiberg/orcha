# Publishing Orcha to NPM

## Prerequisites

1. Create an npm account at https://www.npmjs.com/signup
2. Login to npm locally:
   ```bash
   npm login
   ```

## Publishing Steps

### 1. Verify package is ready

```bash
# Run build to ensure everything compiles
npm run build

# Test the install script
./install.sh  # Should detect all dependencies

# Run a dry-run publish to see what will be included
npm publish --dry-run
```

### 2. Check package contents

The dry-run will show what files will be published. Should include:
- `bin/` - CLI entry points
- `dist/` - Compiled JavaScript
- `src/web/public/` - Web dashboard assets
- `README.md`, `LICENSE`, `package.json`

Should NOT include:
- `src/*.ts` - TypeScript source (dist/ has compiled versions)
- `node_modules/`
- `.git/`

### 3. Publish to npm

```bash
# Publish scoped package (requires --access public for first publish)
npm publish --access public

# Subsequent publishes can just use:
npm publish
```

### 4. Test installation

```bash
# In a different directory
npm install -g @esbenwiberg/orcha

# Verify it works
orcha --version
orcha --help
```

## Updating After Publish

```bash
# Bump version (patch/minor/major)
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.1 -> 0.2.0
npm version major  # 0.2.0 -> 1.0.0

# Publish new version
npm publish

# Push version tag to GitHub
git push --follow-tags
```

## Package Name

The package is published as `@esbenwiberg/orcha` (scoped package).

- Users install with: `npm install -g @esbenwiberg/orcha`
- But the command is still just `orcha` (no scope prefix needed)

## Troubleshooting

**"You do not have permission to publish"**
- The package name might be taken
- Try a scoped package: `@esbenwiberg/orcha`

**"Missing dist/ folder"**
- Run `npm run build` first
- The `prepublishOnly` script should auto-build, but verify it worked

**"Package size too large"**
- Check `.npmignore` is excluding unnecessary files
- Run `npm publish --dry-run` to see what's included
