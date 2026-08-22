#!/usr/bin/env node

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional debug output coloring.
	"supports-color",
]);
const allowedEmptyLegacyModules = new Set([
	"cli.js",
	"core/diagnostics.js",
	"modes/rpc/rpc-types.js",
	"rpc-entry.js",
	"utils/image-resize-worker.js",
]);

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function isBuiltinModule(specifier) {
	const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
	return builtinModules.includes(specifier) || builtinModules.includes(normalized);
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltinModule(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

function toModuleSpecifier(fromDir, target) {
	const path = relative(fromDir, target).replaceAll("\\", "/");
	return path.startsWith(".") ? path : `./${path}`;
}

function collectBindingNames(name, names) {
	if (ts.isIdentifier(name)) {
		names.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) {
			collectBindingNames(element.name, names);
		}
	}
}

const moduleExportsCache = new Map();

function getModuleExports(path, ancestors = new Set()) {
	const cached = moduleExportsCache.get(path);
	if (cached) return cached;
	if (ancestors.has(path)) {
		throw new Error(`Circular export-star chain while reading ${relative(repoRoot, path)}`);
	}

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(path);
	const names = new Set();
	const exportStars = [];
	const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) {
			names.add("default");
			continue;
		}
		if (ts.isExportDeclaration(statement)) {
			if (statement.exportClause) {
				if (ts.isNamespaceExport(statement.exportClause)) {
					names.add(statement.exportClause.name.text);
				} else {
					for (const element of statement.exportClause.elements) {
						names.add(element.name.text);
					}
				}
			} else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
				exportStars.push(statement.moduleSpecifier.text);
			}
			continue;
		}

		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
			continue;
		}
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
			names.add("default");
			continue;
		}
		if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
			names.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				collectBindingNames(declaration.name, names);
			}
		}
	}

	for (const specifier of exportStars) {
		if (!specifier.startsWith(".")) {
			throw new Error(`External export star "${specifier}" in ${relative(repoRoot, path)} is not supported`);
		}
		const target = resolve(dirname(path), specifier);
		for (const name of getModuleExports(target, nextAncestors)) {
			if (name !== "default") names.add(name);
		}
	}

	moduleExportsCache.set(path, names);
	return names;
}

function collectLegacyModules(dir = codingAgentDistDir) {
	const modules = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	for (const entry of entries) {
		if (dir === codingAgentDistDir && (entry.name === "bundle" || entry.name === "bun")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			modules.push(...collectLegacyModules(path));
			continue;
		}
		if (!entry.name.endsWith(".js") || !existsSync(`${path.slice(0, -3)}.d.ts`)) continue;
		modules.push(path);
	}
	return modules;
}

function createLegacyInternalsEntry(tempDir, modules) {
	const entryPath = join(tempDir, "legacy-internals.js");
	const moduleInfo = [];
	const lines = [];
	const usedAliases = new Set();

	for (const path of modules) {
		const names = Array.from(getModuleExports(path)).sort();
		const relativePath = relative(codingAgentDistDir, path).replaceAll("\\", "/");
		if (names.length === 0) {
			if (!allowedEmptyLegacyModules.has(relativePath)) {
				throw new Error(`Legacy module has no exports and needs an explicit facade policy: ${relativePath}`);
			}
			moduleInfo.push({ exports: [], path, relativePath });
			continue;
		}

		const exports = names.map((name) => {
			if (name !== "default" && !ts.isIdentifierText(name, ts.ScriptTarget.Latest)) {
				throw new Error(`Unsupported export name "${name}" in ${relative(repoRoot, path)}`);
			}
			let alias = name;
			let suffix = 2;
			while (usedAliases.has(alias)) {
				alias = `${name}$${suffix++}`;
			}
			usedAliases.add(alias);
			const specifier = alias === name ? name : `${name} as ${alias}`;
			lines.push(`export { ${specifier} } from ${JSON.stringify(toModuleSpecifier(tempDir, path))};`);
			return { alias, name };
		});
		moduleInfo.push({ exports, path, relativePath });
	}

	writeFileSync(entryPath, `${lines.join("\n")}\n`);
	return { entryPath, moduleInfo };
}

function formatModuleSpecifier(element) {
	return element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text;
}

function deduplicateLegacyInternals(moduleInfo) {
	const path = join(bundleDir, "internals.js");
	const code = readFileSync(path, "utf8");
	const sourceFile = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const preferredAliases = new Set(
		moduleInfo.flatMap((module) =>
			module.exports.filter(({ alias, name }) => alias === name).map(({ alias }) => alias),
		),
	);
	const aliasesByBinding = new Map();
	const exportDeclarations = [];

	for (const statement of sourceFile.statements) {
		if (
			!ts.isExportDeclaration(statement) ||
			statement.moduleSpecifier ||
			!statement.exportClause ||
			!ts.isNamedExports(statement.exportClause)
		) {
			continue;
		}
		exportDeclarations.push(statement);
		for (const element of statement.exportClause.elements) {
			const binding = element.propertyName?.text ?? element.name.text;
			const aliases = aliasesByBinding.get(binding);
			if (aliases) aliases.push(element.name.text);
			else aliasesByBinding.set(binding, [element.name.text]);
		}
	}

	const canonicalByAlias = new Map();
	for (const aliases of aliasesByBinding.values()) {
		const canonical = aliases.find((alias) => preferredAliases.has(alias)) ?? aliases[0];
		for (const alias of aliases) canonicalByAlias.set(alias, canonical);
	}

	for (const module of moduleInfo) {
		for (const exported of module.exports) {
			const canonical = canonicalByAlias.get(exported.alias);
			if (!canonical) {
				throw new Error(`Bundled internals omitted legacy export ${exported.alias} from ${module.relativePath}`);
			}
			exported.alias = canonical;
		}
	}

	const replacements = exportDeclarations.map((statement) => {
		const elements = statement.exportClause.elements.filter(
			(element) => canonicalByAlias.get(element.name.text) === element.name.text,
		);
		return {
			end: statement.end,
			start: statement.getStart(sourceFile),
			text: `export { ${elements.map(formatModuleSpecifier).join(", ")} };`,
		};
	});
	let deduplicated = code;
	for (const replacement of replacements.reverse()) {
		deduplicated = `${deduplicated.slice(0, replacement.start)}${replacement.text}${deduplicated.slice(replacement.end)}`;
	}
	writeFileSync(path, deduplicated);
	return Array.from(canonicalByAlias.entries()).filter(([alias, canonical]) => alias !== canonical).length;
}

function formatModuleLists(code) {
	const sourceFile = ts.createSourceFile("internals.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const replacements = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length < 2) continue;
			const specifiers = bindings.elements.map((element) => `  ${formatModuleSpecifier(element)},`).join("\n");
			replacements.push({
				end: statement.end,
				start: statement.getStart(sourceFile),
				text: `import {\n${specifiers}\n} from ${statement.moduleSpecifier.getText(sourceFile)};`,
			});
		} else if (ts.isExportDeclaration(statement) && statement.exportClause) {
			if (!ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.length < 2) continue;
			const specifiers = statement.exportClause.elements
				.map((element) => `  ${formatModuleSpecifier(element)},`)
				.join("\n");
			const from = statement.moduleSpecifier ? ` from ${statement.moduleSpecifier.getText(sourceFile)}` : "";
			replacements.push({
				end: statement.end,
				start: statement.getStart(sourceFile),
				text: `export {\n${specifiers}\n}${from};`,
			});
		}
	}

	let formatted = code;
	for (const replacement of replacements.reverse()) {
		formatted = `${formatted.slice(0, replacement.start)}${replacement.text}${formatted.slice(replacement.end)}`;
	}
	return formatted;
}

async function formatLegacyInternals() {
	const path = join(bundleDir, "internals.js");
	const result = await transform(readFileSync(path, "utf8"), {
		format: "esm",
		legalComments: "none",
		loader: "js",
		minify: false,
		target: "node22.19",
	});
	writeFileSync(path, formatModuleLists(result.code));
}

function writeLegacyFacades(moduleInfo, imageResizeWorkerOutput) {
	for (const module of moduleInfo) {
		let content;
		if (module.exports.length > 0) {
			const specifier = toModuleSpecifier(dirname(module.path), join(bundleDir, "internals.js"));
			const exports = module.exports
				.map(({ alias, name }) => (alias === name ? name : `${alias} as ${name}`))
				.join(", ");
			content = `export { ${exports} } from ${JSON.stringify(specifier)};\n`;
		} else if (module.relativePath === "cli.js") {
			content = `#!/usr/bin/env node\nimport ${JSON.stringify(toModuleSpecifier(dirname(module.path), join(bundleDir, "cli.js")))};\n`;
		} else if (module.relativePath === "rpc-entry.js") {
			content = `#!/usr/bin/env node\nimport ${JSON.stringify(toModuleSpecifier(dirname(module.path), join(bundleDir, "rpc-entry.js")))};\n`;
		} else if (module.relativePath === "utils/image-resize-worker.js") {
			content = `import ${JSON.stringify(toModuleSpecifier(dirname(module.path), imageResizeWorkerOutput))};\n`;
		} else {
			content = "export {};\n";
		}
		writeFileSync(module.path, content);
		rmSync(`${module.path}.map`, { force: true });
	}
	chmodSync(join(codingAgentDistDir, "cli.js"), 0o755);
	chmodSync(join(codingAgentDistDir, "rpc-entry.js"), 0o755);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "client", "index.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

const legacyModules = collectLegacyModules();
const tempDir = mkdtempSync(join(codingAgentDistDir, ".bundle-build-"));
const { entryPath: legacyInternalsEntry, moduleInfo } = createLegacyInternalsEntry(tempDir, legacyModules);

try {
	rmSync(bundleDir, { force: true, recursive: true });
	mkdirSync(bundleDir, { recursive: true });

	const mainResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: {
			cli: join(codingAgentDistDir, "cli.js"),
			client: join(codingAgentDistDir, "client", "index.js"),
			index: join(codingAgentDistDir, "index.js"),
			internals: legacyInternalsEntry,
			"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
		},
		outdir: bundleDir,
		chunkNames: "chunks/[name]-[hash]",
		splitting: true,
	});

	const bedrockLoaderOutput = findContainingOutput(
		mainResult.metafile,
		"packages/ai/dist/api/bedrock-converse-stream.lazy.js",
	);
	const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
	const imageResizeOutput = findContainingOutput(
		mainResult.metafile,
		"packages/coding-agent/dist/utils/image-resize.js",
	);
	if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
		throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
	}

	// These implementations are reached through variable-specifier imports or a
	// worker URL, so the main bundle cannot follow them. Emit one self-contained
	// file per implementation beside the code that resolves it.
	const lazyResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: {
			anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
			"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
			"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
			"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
			"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
			"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
			openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
			radius: join(aiDistDir, "auth", "oauth", "radius.js"),
			xai: join(aiDistDir, "auth", "oauth", "xai.js"),
		},
		outdir: dirname(bedrockLoaderOutput),
		splitting: false,
	});

	const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
	if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
		throw new Error("Image resize implementation and worker were emitted into different directories");
	}

	validateExternalImports([mainResult.metafile, lazyResult.metafile]);
	const deduplicatedAliases = deduplicateLegacyInternals(moduleInfo);
	await formatLegacyInternals();
	writeLegacyFacades(moduleInfo, imageResizeWorkerOutput);
	chmodSync(join(bundleDir, "cli.js"), 0o755);
	chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

	const files = new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size;
	const mib = outputBytes([mainResult.metafile, lazyResult.metafile]) / (1024 * 1024);
	console.log(
		`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB), ${moduleInfo.length} legacy facades, and collapsed ${deduplicatedAliases} re-export aliases`,
	);
} finally {
	rmSync(tempDir, { force: true, recursive: true });
}
