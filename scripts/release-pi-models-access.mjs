#!/usr/bin/env node
/**
 * Release script for the pi-models-access package
 * (packages/coding-agent/extensions/pi-models-access).
 *
 * The package keeps an independent version line (currently 1.1.1), decoupled
 * from pi's lockstep release process: scripts/release.mjs only touches the
 * npm workspace packages, and this directory is not a workspace member.
 *
 * Usage:
 *   node scripts/release-pi-models-access.mjs <major|minor|patch|x.y.z> [--dry-run] [--commit]
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Compute the new version and verify it is not already published on npm
 * 3. Verify the CHANGELOG has a [Unreleased] section
 * 4. With --dry-run: verify the version, the CHANGELOG, and the tarball
 *    contents without writing files or publishing
 * 5. Bump package.json and rewrite CHANGELOG [Unreleased] -> [version] - date
 * 6. Add a fresh [Unreleased] section for the next cycle
 * 7. Install dependencies if needed, then build (tsc) inside the package dir
 * 8. Validate the tarball with npm pack --dry-run
 * 9. Publish with npm publish
 * 10. With --commit: commit the version/changelog changes and tag
 *    pi-models-access@<version>. Push the tag manually to trigger the
 *    publish-pi-models-access GitHub Actions workflow.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const RELEASE_TARGET = args.find((a) => !a.startsWith("--"));
const DRY_RUN = args.includes("--dry-run");
const COMMIT = args.includes("--commit");
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SCRIPT_DIR, "..", "packages", "coding-agent", "extensions", "pi-models-access");
const PACKAGE_JSON = join(PACKAGE_DIR, "package.json");
const CHANGELOG = join(PACKAGE_DIR, "CHANGELOG.md");

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release-pi-models-access.mjs <major|minor|patch|x.y.z> [--dry-run] [--commit]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function bumpVersion(version, type) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

function isPublished(name, version) {
	const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0;
}

let pkg;
try {
	pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8"));
} catch (e) {
	console.error(`Error: invalid ${PACKAGE_JSON}: ${e.message}`);
	process.exit(1);
}
const currentVersion = pkg.version;

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Compute the new version
let version;
if (BUMP_TYPES.has(RELEASE_TARGET)) {
	version = bumpVersion(currentVersion, RELEASE_TARGET);
	console.log(`Bumping version (${RELEASE_TARGET}): ${currentVersion} -> ${version}\n`);
} else {
	if (compareVersions(RELEASE_TARGET, currentVersion) <= 0) {
		console.error(`Error: explicit version ${RELEASE_TARGET} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}
	version = RELEASE_TARGET;
	console.log(`Setting explicit version: ${currentVersion} -> ${version}\n`);
}

// 3. Verify the new version is not already published
console.log(`Verifying ${pkg.name}@${version} is not published on npm...`);
if (isPublished(pkg.name, version)) {
	console.error(`Error: ${pkg.name}@${version} is already published on npm. Bump the version first.`);
	process.exit(1);
}
console.log("  Not published\n");

// 4. Verify the CHANGELOG has a [Unreleased] section
const changelog = readFileSync(CHANGELOG, "utf-8");
if (!changelog.includes("## [Unreleased]")) {
	console.error("Error: CHANGELOG.md has no [Unreleased] section. Add one before releasing.");
	process.exit(1);
}

if (DRY_RUN) {
	// Dry run: no file writes, no build, no publish.
	console.log("Dry run: skipping file writes, build, and publish.");
	console.log(`  Would set package.json version: ${currentVersion} -> ${version}`);
	const date = new Date().toISOString().split("T")[0];
	console.log(`  Would rewrite CHANGELOG.md: [Unreleased] -> [${version}] - ${date}, then add a fresh [Unreleased] section`);
	console.log();

	// Validate the tarball contents without touching anything.
	console.log("Validating tarball...");
	run("npm pack --dry-run", { cwd: PACKAGE_DIR });
	console.log();
	console.log(`=== ${pkg.name} v${version} (dry run) ===`);
	process.exit(0);
}

// 5. Write version + changelog, and the fresh [Unreleased] section for next cycle
const date = new Date().toISOString().split("T")[0];
console.log("Updating package.json and CHANGELOG.md...");
writeFileSync(PACKAGE_JSON, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
const updated = changelog
	.replace("## [Unreleased]", `## [${version}] - ${date}`)
	.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
writeFileSync(CHANGELOG, updated);
console.log(`  package.json: ${currentVersion} -> ${version}`);
console.log(`  CHANGELOG.md: [Unreleased] -> [${version}] - ${date}, fresh [Unreleased] added\n`);

// 6. Install dependencies if needed, then build
if (!existsSync(join(PACKAGE_DIR, "node_modules"))) {
	console.log("Installing dependencies (no node_modules present)...");
	run("npm install --ignore-scripts --no-workspaces", { cwd: PACKAGE_DIR });
	console.log();
}
console.log("Building (tsc)...");
run("npm run build", { cwd: PACKAGE_DIR });
console.log();

// 7. Validate the tarball contents
console.log("Validating tarball...");
run("npm pack --dry-run", { cwd: PACKAGE_DIR });
console.log();

// 8. Publish
console.log("Publishing...");
run("npm publish", { cwd: PACKAGE_DIR });
console.log();

// 9. Commit and tag
if (COMMIT) {
	console.log("Committing and tagging...");
	run(`git add ${PACKAGE_JSON} ${CHANGELOG}`);
	run(`git commit -m "chore(models-access): release v${version}"`);
	run(`git tag pi-models-access@${version}`);
	console.log(`  Tagged pi-models-access@${version}`);
	console.log("  Push the tag to trigger the publish-pi-models-access workflow:");
	console.log(`  git push <remote> ${gitBranch()} --tags`);
}

function gitBranch() {
	return run("git branch --show-current", { silent: true }).trim();
}

console.log(`\n=== ${pkg.name} v${version} released ===`);
