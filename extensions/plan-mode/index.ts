import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPlanPath, readPlan, writePlan } from "./plan-file.ts";
import { showPlanReview, type ReviewChoice } from "./review-ui.ts";

const CONFIG_NAME = "plan-mode.json";
const STATE_TYPE = "plan-mode-state";
const PLAN_TOOLS = new Set(["read", "grep", "find", "ls", "plan_save", "plan_present"]);
const READ_ONLY_BASH_COMMANDS = new Set([
	"pwd", "ls", "find", "grep", "rg", "cat", "head", "tail", "wc", "file", "stat",
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);

/** Parse plain words, quoted literals, pipelines, and safe && chains. Anything
 * the small grammar cannot represent is rejected instead of being delegated to a shell. */
function parseReadOnlyBashCommand(command: unknown): string[][][] | undefined {
	if (typeof command !== "string" || !command.trim() || /[\r\n\u2028\u2029\0\x00-\x08\x0b-\x1f\x7f]/.test(command)) return undefined;

	const conjunctions: string[][][] = [];
	let pipelines: string[][] = [];
	let stage: string[] = [];
	let word = "";
	let hasWord = false;
	let quote: "'" | '"' | undefined;
	const finishWord = () => {
		if (!hasWord) return;
		stage.push(word);
		word = "";
		hasWord = false;
	};

	for (let i = 0; i < command.length;) {
		const char = command[i]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			i++;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
				i++;
				continue;
			}
			if (char === "$" || char === "`" || char === "!") return undefined;
			if (char === "\\") {
				const next = command[i + 1];
				if (next === undefined || next === "!") return undefined;
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					word += next;
					i += 2;
					continue;
				}
				// In double quotes, a backslash before any other character is literal.
				word += char;
				i++;
				continue;
			}
			word += char;
			i++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasWord = true;
			i++;
		} else if (char === "|") {
			if (command[i + 1] === "|") return undefined;
			finishWord();
			if (!stage.length) return undefined;
			pipelines.push(stage);
			stage = [];
			i++;
		} else if (char === "&") {
			if (command[i + 1] !== "&") return undefined;
			finishWord();
			if (!stage.length) return undefined;
			pipelines.push(stage);
			conjunctions.push(pipelines);
			pipelines = [];
			stage = [];
			i += 2;
		} else if (char === " " || char === "\t") {
			finishWord();
			i++;
		} else if (/[A-Za-z0-9_./:=,+@%-]/.test(char)) {
			word += char;
			hasWord = true;
			i++;
		} else {
			// This excludes redirects, substitutions, glob expansion, comments,
			// escaped syntax, and all other shell grammar/operators.
			return undefined;
		}
	}
	if (quote) return undefined;
	finishWord();
	if (!stage.length) return undefined;
	pipelines.push(stage);
	conjunctions.push(pipelines);
	return conjunctions;
}

const FIND_VALUE_PREDICATES = new Set([
	"-amin", "-anewer", "-atime", "-cmin", "-cnewer", "-ctime", "-gid", "-group",
	"-iname", "-inum", "-ipath", "-iregex", "-iwholename", "-maxdepth", "-mindepth",
	"-mmin", "-mtime", "-name", "-newer", "-path", "-perm", "-printf", "-regex",
	"-size", "-samefile", "-type", "-uid", "-user", "-wholename",
]);
const FIND_SAFE_PREDICATES = new Set([
	"-a", "-and", "-daystart", "-depth", "-empty", "-executable", "-false", "-follow",
	"-ignore_readdir_race", "-ls", "-mount", "-noleaf", "-noignore_readdir_race", "-not",
	"-o", "-or", "-print", "-print0", "-quit", "-readable", "-true", "-writable", "-xdev", ",",
]);
const FIND_TYPES = new Set(["b", "c", "d", "f", "l", "p", "s", "D", "w"]);

function isReadOnlyFind(args: string[]): boolean {
	if (args.length === 0) return false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (/^-(?:exec|ok|delete|fprint|fprintf|fls)/i.test(arg)) return false;
		if (FIND_VALUE_PREDICATES.has(arg)) {
			if (i + 1 >= args.length) return false;
			if (arg === "-type" && !FIND_TYPES.has(args[i + 1]!)) return false;
			if ((arg === "-maxdepth" || arg === "-mindepth") && !/^\d+$/.test(args[i + 1]!)) return false;
			i++;
			continue;
		}
		if (FIND_SAFE_PREDICATES.has(arg) || arg === "-H" || arg === "-L" || arg === "-P") continue;
		// Starting paths are inert operands. Unknown find options/actions fail closed.
		if (arg.startsWith("-")) return false;
	}
	return true;
}

function hasDangerousReadOption(command: string, args: string[]): boolean {
	if ((command === "rg" || command === "grep") && args.some((arg) => /^--pre(?:-glob)?(?:=|$)/.test(arg))) return true;
	if (command === "tail" && args.some((arg) => /^-[^-]*[fF]/.test(arg) || /^--follow(?:=|$)/.test(arg))) return true;
	if (command === "file" && args.some((arg) => /^--compile(?:=|$)/.test(arg) || /^-[^-]*C/.test(arg))) return true;
	if (command === "git") {
		const blockedGitOptions = /^(?:--(?:output|ext-diff|textconv|paginate|pager|exec-path|config-env)(?:=|$)|-c$|-o)/;
		if (args.some((arg) => blockedGitOptions.test(arg))) return true;
	}
	return false;
}

function isReadOnlyBashCommand(command: unknown): boolean {
	const conjunctions = parseReadOnlyBashCommand(command);
	if (!conjunctions) return false;
	return conjunctions.every((pipelines) => pipelines.every((tokens) => {
		const [name, ...args] = tokens;
		if (!name) return false;
		if (name === "git") {
			return GIT_READ_ONLY_SUBCOMMANDS.has(args[0] ?? "") && !hasDangerousReadOption(name, args);
		}
		if (!READ_ONLY_BASH_COMMANDS.has(name)) return false;
		if (name === "find") return isReadOnlyFind(args);
		return !hasDangerousReadOption(name, args);
	}));
}

// Intentionally identical in Plan and Build. Mode-specific state is a separate
// custom context message so toggling modes never rebuilds the system prompt.
const STATIC_SYSTEM_INSTRUCTIONS = `\n\n## Plan-mode extension workflow\nThe packaged skill named plan-writing contains the canonical, generic implementation-planning instructions. Whenever the extension context says Plan mode is active, load and follow the discovered plan-writing skill before drafting or refining a plan. Use this extension's plan_save tool to write the plan to its extension-owned file, then call plan_present with only the exact relative path returned by plan_save. plan_present displays that file for explicit user review; do not send the plan inline, treat a tool call as approval, or execute it until the user approves in the review UI. In Plan mode, take no resource-mutating action: plan_save is the only write capability. This instruction is fixed across modes; the extension supplies the current mode separately.`;

type ModelRef = { provider: string; id: string };
type Mode = "plan" | "build";
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type ConfiguredEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
type ModeModelConfig = { id: string; effort: ConfiguredEffort };
type ProfileConfig = { plan?: ModeModelConfig; build?: ModeModelConfig };
type PlanConfig = {
	profiles: Record<string, ProfileConfig>;
	profileOrder: string[];
	selectedProfile?: string;
	legacy: boolean;
};
type LoadedPlanConfig = { config: PlanConfig; path: string; raw?: string; error?: string };
type ProfileSelection = { name: string; profile: ProfileConfig };
type PersistedState = {
	mode: Mode;
	planPath?: string;
	prePlanModel?: ModelRef;
	prePlanEffort?: PiThinkingLevel;
};
type PendingApproval = {
	token: string;
	choice: "execute-new" | "execute-here";
	path: string;
	sessionId: string;
	profileName?: string;
	profileSnapshot?: ProfileConfig;
};
type FreshHandoff = {
	token: string;
	path: string;
	ownerSessionId: string;
	profileName?: string;
	profileSnapshot?: ProfileConfig;
};
const FRESH_HANDOFF_TYPE = "plan-mode-fresh-handoff";
const FRESH_HANDOFF_USED_TYPE = "plan-mode-fresh-handoff-used";

function modelRef(model: ExtensionContext["model"]): ModelRef | undefined {
	return model ? { provider: model.provider, id: model.id } : undefined;
}

function modelKey(model: ModelRef | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function parseModelRef(value: unknown, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() !== value) {
		throw new Error(`${key} must be a provider/model-id string`);
	}
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) {
		throw new Error(`${key} must have the form provider/model-id`);
	}
	return value;
}

function parseModeModel(value: unknown, key: string): ModeModelConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${key} must be an object with id and effort`);
	}
	const record = value as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((field) => field !== "id" && field !== "effort");
	if (unknownKeys.length) throw new Error(`${key} has unknown key(s): ${unknownKeys.join(", ")}`);
	const id = parseModelRef(record.id, `${key}.id`);
	if (!id) throw new Error(`${key}.id is required`);
	const effort = record.effort;
	if (effort !== "default" && effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max") {
		throw new Error(`${key}.effort must be default, low, medium, high, xhigh, or max`);
	}
	return { id, effort };
}

function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
		value === "high" || value === "xhigh" || value === "max";
}

function toPiThinkingLevel(effort: ConfiguredEffort): PiThinkingLevel | undefined {
	if (effort === "default") return undefined;
	return effort;
}

function configFilePath(): string {
	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return resolve(configDir, CONFIG_NAME);
}

function emptyConfig(): PlanConfig {
	return { profiles: Object.create(null) as Record<string, ProfileConfig>, profileOrder: [], legacy: false };
}

function assertNoDuplicateProfileKeys(raw: string): string[] {
	let index = 0;
	const profileOrder: string[] = [];
	function skipWhitespace(): void {
		while (/\s/.test(raw[index] ?? "")) index++;
	}
	function readString(): string {
		const start = index++;
		while (index < raw.length) {
			const char = raw[index++];
			if (char === "\\") index++;
			else if (char === '"') break;
		}
		return JSON.parse(raw.slice(start, index)) as string;
	}
	function readObject(checkProfileKeys: boolean, isRoot = false): void {
		index++; // {
		skipWhitespace();
		if (raw[index] === "}") { index++; return; }
		const seen = new Set<string>();
		while (index < raw.length) {
			skipWhitespace();
			const key = readString();
			if (seen.has(key)) throw new Error(checkProfileKeys ? `duplicate profile key: ${key}` : `duplicate JSON key: ${key}`);
			seen.add(key);
			if (checkProfileKeys) profileOrder.push(key);
			skipWhitespace();
			index++; // : (JSON.parse has already validated the syntax)
			skipWhitespace();
			readValue(isRoot && key === "profiles");
			skipWhitespace();
			if (raw[index] === "}") { index++; return; }
			index++; // ,
		}
	}
	function readValue(checkProfileKeys = false): void {
		skipWhitespace();
		if (raw[index] === "{") return readObject(checkProfileKeys);
		if (raw[index] === "[") {
			index++;
			skipWhitespace();
			if (raw[index] === "]") { index++; return; }
			while (index < raw.length) {
				readValue();
				skipWhitespace();
				if (raw[index] === "]") { index++; return; }
				index++; // ,
			}
			return;
		}
		if (raw[index] === '"') { readString(); return; }
		while (index < raw.length && !/[\s,}\]]/.test(raw[index]!)) index++;
	}

	skipWhitespace();
	if (raw[index] === "{") readObject(false, true);
	return profileOrder;
}

function parseConfig(raw: string): PlanConfig {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("configuration must be a JSON object");
	}
	const profileOrder = assertNoDuplicateProfileKeys(raw);
	const record = value as Record<string, unknown>;
	const hasProfiles = Object.prototype.hasOwnProperty.call(record, "profiles");
	const hasLegacyPair = Object.prototype.hasOwnProperty.call(record, "plan") ||
		Object.prototype.hasOwnProperty.call(record, "build");

	if (hasProfiles && hasLegacyPair) throw new Error("profiles cannot be mixed with top-level plan/build settings");
	if (hasProfiles) {
		const unknownKeys = Object.keys(record).filter((key) => key !== "profiles" && key !== "selectedProfile");
		if (unknownKeys.length) throw new Error(`unknown key(s): ${unknownKeys.join(", ")}`);
		const source = record.profiles;
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new Error("profiles must be an object containing 1–5 named profiles");
		}
		const names = profileOrder;
		if (names.length < 1 || names.length > 5) throw new Error(`profiles must contain 1–5 entries; found ${names.length}`);
		const profiles = Object.create(null) as Record<string, ProfileConfig>;
		for (const name of names) {
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || name.trim() !== name ||
				name === "__proto__" || name === "constructor" || name === "prototype") {
				throw new Error(`invalid profile name ${JSON.stringify(name)}; use a safe single token such as codex`);
			}
			const item = (source as Record<string, unknown>)[name];
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				throw new Error(`profiles.${name} must contain both plan and build settings`);
			}
			const pair = item as Record<string, unknown>;
			const unknownFields = Object.keys(pair).filter((field) => field !== "plan" && field !== "build");
			if (unknownFields.length) throw new Error(`profiles.${name} has unknown key(s): ${unknownFields.join(", ")}`);
			const plan = parseModeModel(pair.plan, `profiles.${name}.plan`);
			const build = parseModeModel(pair.build, `profiles.${name}.build`);
			if (!plan || !build) throw new Error(`profiles.${name} requires both plan and build settings`);
			profiles[name] = { plan, build };
		}
		let selectedProfile: string | undefined;
		if (Object.prototype.hasOwnProperty.call(record, "selectedProfile")) {
			if (typeof record.selectedProfile !== "string") throw new Error("selectedProfile must name a configured profile");
			selectedProfile = record.selectedProfile;
			if (!Object.prototype.hasOwnProperty.call(profiles, selectedProfile)) {
				throw new Error(`selectedProfile ${JSON.stringify(selectedProfile)} does not name a configured profile`);
			}
		}
		return { profiles, profileOrder: names, selectedProfile, legacy: false };
	}

	const unknownKeys = Object.keys(record).filter((key) => key !== "plan" && key !== "build");
	if (unknownKeys.length) throw new Error(`unknown key(s): ${unknownKeys.join(", ")}`);
	const plan = parseModeModel(record.plan, "plan");
	const build = parseModeModel(record.build, "build");
	const profiles = Object.create(null) as Record<string, ProfileConfig>;
	const legacyOrder = plan || build ? ["default"] : [];
	if (legacyOrder.length) profiles.default = { plan, build };
	return { profiles, profileOrder: legacyOrder, legacy: true };
}

async function loadConfig(): Promise<LoadedPlanConfig> {
	const path = configFilePath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: emptyConfig(), path };
		return { config: emptyConfig(), path, error: `Cannot read ${path}: ${String(error)}` };
	}
	try {
		return { config: parseConfig(raw), path, raw };
	} catch (error) {
		return {
			config: emptyConfig(),
			path,
			raw,
			error: `Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function profileSelection(config: PlanConfig): ProfileSelection | undefined {
	const name = config.selectedProfile ?? config.profileOrder[0];
	return name && Object.prototype.hasOwnProperty.call(config.profiles, name)
		? { name, profile: config.profiles[name]! }
		: undefined;
}

function sameProfile(a: ProfileConfig | undefined, b: ProfileConfig | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function settingsRef(settings: ModeModelConfig | undefined): ModelRef | undefined {
	if (!settings) return undefined;
	const slash = settings.id.indexOf("/");
	return { provider: settings.id.slice(0, slash), id: settings.id.slice(slash + 1) };
}

function selectedConfigText(config: PlanConfig, name: string): string {
	const entries = config.profileOrder.map((profileName) => {
		const formatted = JSON.stringify(config.profiles[profileName]!, null, 2)!.replaceAll("\n", "\n    ");
		return `    ${JSON.stringify(profileName)}: ${formatted}`;
	});
	return `{
  "profiles": {
${entries.join(",\n")}
  },
  "selectedProfile": ${JSON.stringify(name)}
}\n`;
}

async function readRawConfig(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeConfigAtomically(path: string, expectedRaw: string | undefined, content: string): Promise<void> {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let temporaryExists = false;
	try {
		const file = await open(temporaryPath, "wx", 0o600);
		temporaryExists = true;
		try {
			await file.writeFile(content, { encoding: "utf8" });
			await file.sync();
		} finally {
			await file.close();
		}
		if (await readRawConfig(path) !== expectedRaw) {
			throw new Error("plan-mode.json changed during profile selection; no settings were overwritten");
		}
		await rename(temporaryPath, path);
		temporaryExists = false;
	} finally {
		if (temporaryExists) await unlink(temporaryPath).catch(() => {});
	}
}

function latestState(ctx: ExtensionContext): PersistedState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Record<string, unknown>;
		if (data.mode !== "plan" && data.mode !== "build") continue;
		const ref = data.prePlanModel;
		const prePlanModel = ref && typeof ref === "object" &&
			typeof (ref as ModelRef).provider === "string" && typeof (ref as ModelRef).id === "string"
			? { provider: (ref as ModelRef).provider, id: (ref as ModelRef).id }
			: undefined;
		return {
			mode: data.mode,
			planPath: typeof data.planPath === "string" ? data.planPath : undefined,
			prePlanModel,
			prePlanEffort: isPiThinkingLevel(data.prePlanEffort) ? data.prePlanEffort : undefined,
		};
	}
	return undefined;
}

async function findModel(ctx: ExtensionContext, ref: ModelRef): Promise<NonNullable<ExtensionContext["model"]>> {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model) throw new Error(`Model not found: ${ref.provider}/${ref.id}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Model is unavailable: ${auth.error}`);
	return model;
}

function makeSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plan";
}

async function gitAdminDir(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => undefined);
	if (!root || root.code !== 0 || !root.stdout.trim()) return undefined;
	const admin = await pi.exec("git", ["-C", root.stdout.trim(), "rev-parse", "--absolute-git-dir"], { cwd }).catch(() => undefined);
	return admin?.code === 0 && admin.stdout.trim() ? admin.stdout.trim() : undefined;
}

async function isOwnedPlanPath(pi: ExtensionAPI, ctx: ExtensionContext, path: string, ownerSessionId = ctx.sessionManager.getSessionId()): Promise<boolean> {
	const sessionKey = makeSlug(ownerSessionId).slice(-20) || "session";
	const filename = basename(path);
	const prefix = `plan-${sessionKey}-`;
	if (resolve(path) !== path || !filename.startsWith(prefix) || !/^\d+-plan\.md$/.test(filename.slice(prefix.length))) return false;
	try {
		const folder = dirname(path);
		if (await realpath(folder) !== folder) return false;
		const fileInfo = await lstat(path);
		if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink > 1) return false;
		const admin = await gitAdminDir(pi, ctx.cwd);
		if (admin) {
			const expected = join(await realpath(resolve(admin)), "implementation-plans");
			if (folder === expected) return true;
		}
		const tempRoot = await realpath(tmpdir());
		return dirname(folder) === tempRoot && basename(folder).startsWith(`${makeSlug(basename(resolve(ctx.cwd)))}-implementation-plans.`);
	} catch {
		return false;
	}
}

function formatPlanPath(path: string, cwd: string): string {
	return relative(cwd, path);
}

function planContext(mode: Mode, path: string | undefined): string {
	if (mode === "plan") {
		return `[PLAN MODE ACTIVE]\nYou are planning only. Take no resource-mutating actions. The tool guard permits read, grep, find, ls, plan_save, and plan_present; Bash is conditionally available only for simple read-only commands from pwd, ls, find, grep, rg, cat, head, tail, wc, file, stat, and Git status/diff/log/show. Pipelines and && chains are allowed only when every command independently passes the same checks; for example, pwd && ls -la, rg -n 'PLAN_TOOLS\\b' extensions/plan-mode/index.ts, rg -n '.*;$' extensions/plan-mode/index.ts, and rg -n 'PLAN_TOOLS|READ_ONLY_BASH_COMMANDS' extensions/plan-mode/index.ts | head -5 && git status --short --branch. Single-quoted text is literal; double-quoted text rejects unescaped $, backticks, and !. Other shell chaining/operators (including ;, ||, and &), redirection, substitutions, unrecognized commands, mutating/execution options, and interactive !/!! commands are blocked. Load and follow the discovered plan-writing skill before creating or refining the implementation plan. Inspect relevant project sources and instructions; keep all planning edits inside the extension-owned plan file. Use plan_save({content}) to create/update that file, then call plan_present({path}) with only the exact relative path returned by plan_save. Never present the plan inline or execute it. Only an explicit approval selection inside the review UI authorizes execution.\nCurrent plan file: ${path ?? "not created yet; plan_save will create it"}`;
	}
	return `[BUILD MODE ACTIVE]\nThe user has switched to Build mode. Follow the latest user request normally with the available tools. If the user approved a plan, read the approved plan file and follow its steps; if it is missing, stop and ask rather than guessing.\nPlan file: ${path ?? "none"}`;
}

export default function planMode(pi: ExtensionAPI): void {
	let mode: Mode = "build";
	let planPath: string | undefined;
	let prePlanModel: ModelRef | undefined;
	let prePlanEffort: PiThinkingLevel | undefined;
	let config: PlanConfig = emptyConfig();
	let configError: string | undefined;
	let pendingApproval: PendingApproval | undefined;
	let reviewActive = false;
	let profileChangeInProgress = false;
	let modeTransitionInProgress = false;
	let planPathPromise: Promise<string> | undefined;

	const persistState = () => {
		pi.appendEntry(STATE_TYPE, { mode, planPath, prePlanModel, prePlanEffort } satisfies PersistedState);
	};

	const updateBadge = (ctx: ExtensionContext) => {
		const selected = profileSelection(config);
		const suffix = selected ? ` · ${selected.name}` : "";
		const label = mode === "plan"
			? ctx.ui.theme.fg("text", ctx.ui.theme.bold(`PLAN · read-only${suffix}`))
			: ctx.ui.theme.fg("muted", ctx.ui.theme.bold(`BUILD${suffix}`));
		// A component avoids the one-column padding added to string-array widgets.
		// The trailing blank row separates this badge from the built-in footer.
		ctx.ui.setWidget("plan-mode-indicator", () => ({
			render: () => [label, " "],
			invalidate: () => {},
		}), { placement: "belowEditor" });
	};

	const notifyConfigError = (ctx: ExtensionContext) => {
		if (configError) ctx.ui.notify(configError, "error");
	};

	async function switchToRef(ctx: ExtensionContext, ref: ModelRef | undefined): Promise<void> {
		if (!ref) return;
		const model = await findModel(ctx, ref);
		if (modelKey(modelRef(ctx.model)) === modelKey(ref)) return;
		if (!(await pi.setModel(model))) throw new Error(`Pi could not activate ${ref.provider}/${ref.id}; check credentials and model scope`);
	}

	async function restoreActiveSettings(ctx: ExtensionContext, ref: ModelRef | undefined, effort: PiThinkingLevel): Promise<void> {
		try {
			if (ref && modelKey(modelRef(ctx.model)) !== modelKey(ref)) await switchToRef(ctx, ref);
		} catch {
			// Best effort: retain the original activation error if restoration is unavailable.
		}
		try {
			if (pi.getThinkingLevel() !== effort) pi.setThinkingLevel(effort);
		} catch {
			// Best effort: retain the original activation error if restoration is unavailable.
		}
	}

	async function applyModeSettings(
		ctx: ExtensionContext,
		settings: ModeModelConfig | undefined,
		fallbackModel?: ModelRef,
		fallbackEffort?: PiThinkingLevel,
	): Promise<void> {
		const previousModel = modelRef(ctx.model);
		const previousEffort = pi.getThinkingLevel();
		const configuredRef = settings ? settingsRef(settings) : fallbackModel;
		const effort = settings && settings.effort !== "default"
			? toPiThinkingLevel(settings.effort)
			: fallbackEffort;
		try {
			await switchToRef(ctx, configuredRef);
			if (effort !== undefined && pi.getThinkingLevel() !== effort) pi.setThinkingLevel(effort);
		} catch (error) {
			await restoreActiveSettings(ctx, previousModel, previousEffort);
			throw error;
		}
	}

	async function toggleMode(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current agent turn to finish before changing modes.", "warning");
			return;
		}
		if (profileChangeInProgress || modeTransitionInProgress) {
			ctx.ui.notify("A model or mode change is already in progress.", "warning");
			return;
		}
		modeTransitionInProgress = true;
		try {
			const loaded = await loadConfig();
			config = loaded.config;
			configError = loaded.error;
			notifyConfigError(ctx);
			const selected = profileSelection(config);
			if (mode === "build") {
				const previous = modelRef(ctx.model);
				const previousEffort = pi.getThinkingLevel();
				await applyModeSettings(ctx, selected?.profile.plan);
				mode = "plan";
				prePlanModel = previous;
				prePlanEffort = previousEffort;
				planPath = undefined;
				planPathPromise = undefined;
			} else {
				await applyModeSettings(ctx, selected?.profile.build, prePlanModel, prePlanEffort);
				mode = "build";
				pendingApproval = undefined;
			}
			persistState();
			updateBadge(ctx);
			ctx.ui.notify(mode === "plan" ? "Plan mode enabled. Only the extension-owned plan file may be written." : "Build mode enabled.", "info");
		} catch (error) {
			ctx.ui.notify(`Mode unchanged: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			modeTransitionInProgress = false;
		}
	}

	async function makePlanPath(ctx: ExtensionContext): Promise<string> {
		if (planPath) return planPath;
		if (!planPathPromise) {
			planPathPromise = (async () => {
				const gitDir = await gitAdminDir(pi, ctx.cwd);
				const sessionId = ctx.sessionManager.getSessionId();
				return createPlanPath({ cwd: ctx.cwd, sessionId: sessionId || randomUUID(), gitAdminDir: gitDir });
			})();
		}
		return planPathPromise;
	}

	pi.on("before_agent_start", async (event, ctx) => ({
		// This exact suffix is independent of mode and is never changed by /plan.
		systemPrompt: `${event.systemPrompt}${STATIC_SYSTEM_INSTRUCTIONS}`,
		message: {
			customType: "plan-mode-context",
			content: planContext(mode, planPath ? formatPlanPath(planPath, ctx.cwd) : undefined),
			display: false,
		},
	}));

	pi.on("tool_call", (event) => {
		if (mode !== "plan" || PLAN_TOOLS.has(event.toolName)) return;
		if (event.toolName === "bash" && isReadOnlyBashCommand(event.input.command)) return;
		return {
			block: true,
			reason: event.toolName === "bash"
				? "Plan mode permits Bash only for simple read-only pwd/ls/find/grep/rg/cat/head/tail/wc/file/stat commands and Git status/diff/log/show, including pipelines and && chains where every command is permitted (for example, pwd && ls -la or rg -n 'PLAN_TOOLS\\b' extensions/plan-mode/index.ts). Other shell chaining/operators (including ;, ||, and &), redirection, substitutions, unlisted commands, mutating/execution options, and interactive !/!! commands are blocked."
				: `Plan mode blocks ${event.toolName}: no resource-mutating or unreviewed tools are available. Use read/grep/find/ls or an approved read-only Bash command to inspect, plan_save for the plan file, and plan_present for approval. Toggle with /plan only when you intend to build.`,
		};
	});

	// Also prevent interactive ! commands from bypassing the Plan-mode tool gate.
	pi.on("user_bash", () => {
		if (mode !== "plan") return;
		return { result: { output: "Plan mode blocks shell commands. Use the read-only agent tools or switch to Build mode.", exitCode: 1, cancelled: false, truncated: false } };
	});

	pi.registerTool({
		name: "plan_save",
		label: "Save Plan",
		description: "Write or refine the current implementation plan in the extension-owned plan file. This is the only write operation permitted in Plan mode. Returns the path relative to the session working directory; it never accepts a destination path.",
		parameters: Type.Object({ content: Type.String({ description: "Complete plan Markdown to create or replace" }) }, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (mode !== "plan") throw new Error("plan_save is available only in Plan mode");
			const target = await makePlanPath(ctx);
			await withFileMutationQueue(target, async () => writePlan(target, params.content));
			planPath = target;
			persistState();
			const displayPath = formatPlanPath(target, ctx.cwd);
			return {
				content: [{ type: "text", text: `Plan saved: ${displayPath}` }],
				details: { path: displayPath },
			};
		},
	});

	pi.registerTool({
		name: "plan_present",
		label: "Review Plan",
		description: "Present the extension-owned plan file in a scrollable review UI. Supply only the exact path relative to the session working directory returned by plan_save; never supply an absolute path, alternate spelling, or plan contents. The user chooses refinement, approval, or cancel in the UI.",
		parameters: Type.Object({ path: Type.String({ description: "Exact relative path returned by plan_save, based on the session working directory" }) }, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (mode !== "plan") throw new Error("plan_present is available only in Plan mode");
			if (ctx.mode !== "tui") {
				return { content: [{ type: "text", text: "Interactive plan approval requires Pi TUI mode. No approval was recorded." }], details: {}, terminate: true };
			}
			if (reviewActive) throw new Error("A plan review is already open");
			if (!planPath || isAbsolute(params.path) || resolve(ctx.cwd, params.path) !== planPath ||
				params.path !== formatPlanPath(planPath, ctx.cwd)) {
				throw new Error("plan_present accepts only the exact current extension-owned plan path relative to the session working directory");
			}
			reviewActive = true;
			try {
				const reviewedText = await readPlan(planPath);
				const choice: ReviewChoice | undefined = await showPlanReview(ctx, formatPlanPath(planPath, ctx.cwd), reviewedText);
				if (!choice || choice === "cancel") {
					ctx.ui.notify("Plan review cancelled. Plan mode remains active.", "info");
					return { content: [{ type: "text", text: "Review cancelled; no approval was recorded." }], details: { choice: "cancel" }, terminate: true };
				}
				if (choice === "refine") {
					ctx.ui.notify("Refine the plan in chat. Plan mode remains active.", "info");
					return { content: [{ type: "text", text: "Refinement requested. The user can now describe changes in chat." }], details: { choice }, terminate: true };
				}
				const token = randomUUID();
				const selected = profileSelection(config);
				pendingApproval = {
					token,
					choice,
					path: planPath,
					sessionId: ctx.sessionManager.getSessionId(),
					profileName: selected?.name,
					profileSnapshot: selected ? { ...selected.profile } : undefined,
				};
				pi.sendUserMessage(`/plan-handoff ${token}`, { deliverAs: "followUp", expandPromptTemplates: true });
				return {
					content: [{ type: "text", text: "Plan approval recorded. Handoff queued." }],
					details: { choice },
					terminate: true,
				};
			} finally {
				reviewActive = false;
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle Plan / Build mode",
		handler: async (_args, ctx) => toggleMode(ctx),
	});

	pi.registerCommand("plan-profile", {
		description: "Show or switch the active Plan / Build model profile",
		getArgumentCompletions: (prefix) => {
			const names = config.profileOrder.filter((name) => name.startsWith(prefix));
			return names.length ? names.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim() ? args.trim().split(/\s+/) : [];
			if (tokens.length === 0) {
				const loaded = await loadConfig();
				if (loaded.error) ctx.ui.notify(loaded.error, "error");
				const selected = profileSelection(loaded.config);
				const names = loaded.config.profileOrder;
				ctx.ui.notify(
					`Selected profile: ${selected?.name ?? "(none)"}\nAvailable profiles: ${names.length ? names.join(", ") : "(none configured)"}`,
					loaded.error ? "warning" : "info",
				);
				return;
			}

			const usage = () => {
				const names = config.profileOrder;
				return `Usage: /plan-profile <name>\nAvailable profiles: ${names.length ? names.join(", ") : "(none configured)"}`;
			};
			if (tokens.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tokens[0]!)) {
				ctx.ui.notify(usage(), "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent turn to finish before switching profiles.", "warning");
				return;
			}
			if (reviewActive) {
				ctx.ui.notify("Close the plan review before switching profiles.", "warning");
				return;
			}
			if (profileChangeInProgress || modeTransitionInProgress) {
				ctx.ui.notify("A profile or mode change is already in progress.", "warning");
				return;
			}

			profileChangeInProgress = true;
			try {
				await withFileMutationQueue(configFilePath(), async () => {
					const latest = await loadConfig();
					if (latest.error) throw new Error(latest.error);
					const name = tokens[0]!;
					if (!Object.prototype.hasOwnProperty.call(latest.config.profiles, name)) {
						config = latest.config;
						throw new Error(`Unknown profile ${JSON.stringify(name)}. ${usage()}`);
					}
					const previousSelection = profileSelection(latest.config);
					const target = latest.config.profiles[name]!;
					const previousModel = modelRef(ctx.model);
					const previousEffort = pi.getThinkingLevel();
					try {
						const currentSettings = mode === "plan" ? target.plan : target.build;
						if (currentSettings) await findModel(ctx, settingsRef(currentSettings)!);
						await applyModeSettings(ctx, currentSettings);
						const canPersistSelection = latest.config.legacy
							? Boolean(target.plan && target.build)
							: latest.config.selectedProfile !== name;
						if (canPersistSelection) {
							if (latest.raw === undefined) throw new Error("Configuration disappeared before profile selection could be saved");
							await writeConfigAtomically(latest.path, latest.raw, selectedConfigText(latest.config, name));
						}
					} catch (error) {
						await restoreActiveSettings(ctx, previousModel, previousEffort);
						throw error;
					}
					config = latest.config.legacy && (!target.plan || !target.build)
						? latest.config
						: { ...latest.config, selectedProfile: name, legacy: false };
					configError = undefined;
					if (previousSelection?.name !== name) pendingApproval = undefined;
					updateBadge(ctx);
				});
				ctx.ui.notify(`Plan-mode profile selected: ${tokens[0]}`, "info");
			} catch (error) {
				ctx.ui.notify(`Profile unchanged: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				profileChangeInProgress = false;
			}
		},
	});

	// This command runs in the new session's runtime, so its local `pi` can
	// select the configured Build model and effort without touching the source runtime.
	pi.registerCommand("plan-build-start", {
		description: "Internal one-time fresh-session build handoff",
		handler: async (args, ctx) => {
			const token = args.trim();
			const branch = ctx.sessionManager.getBranch();
			let handoff: FreshHandoff | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
				if (entry.type !== "custom" || entry.customType !== FRESH_HANDOFF_TYPE || !entry.data || typeof entry.data !== "object") continue;
				const data = entry.data as Partial<FreshHandoff>;
				if (data.token === token && typeof data.path === "string" &&
					typeof data.ownerSessionId === "string") {
					handoff = data as FreshHandoff;
					break;
				}
			}
			const wasUsed = branch.some((entry) => entry.type === "custom" &&
				(entry as { customType?: string; data?: { token?: string } }).customType === FRESH_HANDOFF_USED_TYPE &&
				(entry as { data?: { token?: string } }).data?.token === token);
			if (!handoff || wasUsed) {
				ctx.ui.notify("No unused approved fresh-session handoff exists.", "error");
				return;
			}
			if (!(await isOwnedPlanPath(pi, ctx, handoff.path, handoff.ownerSessionId))) {
				ctx.ui.notify("Approved plan path is missing or not owned by the source session. Nothing was executed.", "error");
				return;
			}
			try {
				await readPlan(handoff.path);
			} catch (error) {
				ctx.ui.notify(`Approved plan cannot be read: ${String(error)}. Nothing was executed.`, "error");
				return;
			}
			const latest = await loadConfig();
			if (latest.error) {
				ctx.ui.notify(`${latest.error}. Nothing was executed.`, "error");
				return;
			}
			const selected = profileSelection(latest.config);
			if (selected?.name !== handoff.profileName || !sameProfile(selected?.profile, handoff.profileSnapshot)) {
				ctx.ui.notify("The approved model profile changed before the fresh-session handoff. Review the plan again; nothing was executed.", "warning");
				return;
			}
			config = latest.config;
			configError = undefined;
			if (selected?.profile.build) {
				try {
					await applyModeSettings(ctx, selected.profile.build);
				} catch (error) {
					ctx.ui.notify(`Configured Build model unavailable in the fresh session: ${String(error)}. Nothing was executed.`, "error");
					return;
				}
			}
			pi.appendEntry(FRESH_HANDOFF_USED_TYPE, { token });
			mode = "build";
			persistState();
			updateBadge(ctx);
			ctx.ui.notify("Starting Build in the fresh session.", "info");
			const kickoff = `Implement the complete approved plan below in this fresh Pi session.

Plan file: ${formatPlanPath(handoff.path, ctx.cwd)}

Before editing:
1. Inspect git status --short --branch from the existing working directory. Preserve existing changes.
2. Read project instructions for the files in the plan.
3. Read the plan context, constraints, relevant assumptions, all implementation steps, and named source documents/interfaces.
4. If repository state conflicts with the plan or a required decision is missing, stop and report that issue instead of guessing.

Implement the plan in order. Run only verification authorized by the plan or required by project instructions. At completion, report changed files, commands and results, remaining issues, and any commit created.`;
			pi.sendUserMessage(kickoff);
		},
	});

	pi.registerCommand("plan-handoff", {
		description: "Internal one-time plan approval handoff",
		handler: async (args, ctx) => {
			const approval = pendingApproval;
			const supplied = args.trim();
			if (!approval || !supplied || supplied !== approval.token) {
				ctx.ui.notify("No matching one-time plan approval exists.", "error");
				return;
			}
			pendingApproval = undefined; // one shot, even on failed or cancelled handoff
			await ctx.waitForIdle();
			if (profileChangeInProgress || modeTransitionInProgress || ctx.hasPendingMessages() || mode !== "plan" ||
				ctx.sessionManager.getSessionId() !== approval.sessionId || planPath !== approval.path) {
				ctx.ui.notify("Approval became stale or another message is queued. Review the plan again before executing.", "warning");
				return;
			}
			try {
				await readPlan(approval.path);
			} catch (error) {
				ctx.ui.notify(`Approved plan is no longer readable: ${String(error)}. Nothing was executed.`, "error");
				return;
			}

			const latest = await loadConfig();
			if (latest.error) {
				ctx.ui.notify(`${latest.error}. Approval is stale; review the plan again.`, "error");
				return;
			}
			const selected = profileSelection(latest.config);
			if (selected?.name !== approval.profileName || !sameProfile(selected?.profile, approval.profileSnapshot)) {
				ctx.ui.notify("The selected model profile changed after review. Review the plan again before executing.", "warning");
				return;
			}
			config = latest.config;
			configError = undefined;
			if (approval.choice === "execute-here") {
				mode = "build";
				persistState();
				updateBadge(ctx);
				const kickoff = `Execute the approved implementation plan at ${formatPlanPath(approval.path, ctx.cwd)}. Read it, follow the plan in order, and stop if the file is unavailable or project state conflicts with it.`;
				pi.sendUserMessage(kickoff);
				ctx.ui.notify("Approved. Continuing execution in this session.", "info");
				return;
			}

			const buildRef = settingsRef(selected?.profile?.build);
			if (buildRef) {
				try {
					await findModel(ctx, buildRef);
				} catch (error) {
					ctx.ui.notify(`Build model unavailable: ${error instanceof Error ? error.message : String(error)}. Plan mode remains active.`, "error");
					return;
				}
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			const freshToken = randomUUID();
			const setup = async (sessionManager: SessionManager) => {
				sessionManager.appendCustomEntry(FRESH_HANDOFF_TYPE, {
					token: freshToken,
					path: approval.path,
					ownerSessionId: approval.sessionId,
					profileName: approval.profileName,
					profileSnapshot: approval.profileSnapshot,
				} satisfies FreshHandoff);
			};
			try {
				const result = await ctx.newSession({
					...(parentSession ? { parentSession } : {}),
					setup,
					withSession: async (replacementCtx) => {
						await replacementCtx.sendUserMessage(`/plan-build-start ${freshToken}`, { expandPromptTemplates: true });
					},
				});
				if (result.cancelled) ctx.ui.notify("New-session handoff cancelled. The original Plan session is unchanged.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not start the new Build session: ${String(error)}. Nothing was executed.`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig();
		config = loaded.config;
		configError = loaded.error;
		mode = "build";
		planPath = undefined;
		prePlanModel = undefined;
		prePlanEffort = undefined;
		pendingApproval = undefined;
		planPathPromise = undefined;
		const restored = latestState(ctx);
		if (restored) {
			mode = restored.mode;
			planPath = restored.planPath;
			prePlanModel = restored.prePlanModel;
			prePlanEffort = restored.prePlanEffort;
		}

		if (configError) ctx.ui.notify(configError, "error");
		if (planPath && !(await isOwnedPlanPath(pi, ctx, planPath))) {
			planPath = undefined;
			planPathPromise = undefined;
			ctx.ui.notify("Saved plan path was missing or did not belong to this session; create a new plan before review.", "warning");
			if (mode === "plan") persistState();
		}
		updateBadge(ctx);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		const selected = profileSelection(config);
		const modeSettings = mode === "plan" ? selected?.profile.plan : selected?.profile.build;
		if (modeSettings) {
			try {
				await applyModeSettings(ctx, modeSettings);
			} catch (error) {
				ctx.ui.notify(`Configured ${mode} model is unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});
}
