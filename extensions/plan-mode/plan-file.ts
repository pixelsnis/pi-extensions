import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const MAX_PLAN_BYTES = 200 * 1024;

function safeSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plan";
}

async function createSecureDirectory(path: string): Promise<string> {
	try {
		const before = await lstat(path);
		if (before.isSymbolicLink() || !before.isDirectory()) {
			throw new Error(`Plan directory must be a real directory: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(path, { recursive: true, mode: 0o700 });
	const canonical = await realpath(path);
	if (canonical !== resolve(path)) throw new Error(`Refusing redirected plan directory: ${path}`);
	return canonical;
}

export async function createPlanPath(options: {
	cwd: string;
	sessionId: string;
	gitAdminDir?: string;
}): Promise<string> {
	let planDir: string;
	if (options.gitAdminDir) {
		const gitDir = await realpath(resolve(options.gitAdminDir));
		planDir = await createSecureDirectory(join(gitDir, "implementation-plans"));
	} else {
		const project = safeSlug(basename(resolve(options.cwd)));
		planDir = await realpath(await mkdtemp(join(tmpdir(), `${project}-implementation-plans.`)));
	}
	const session = safeSlug(options.sessionId).slice(-20) || "session";
	const filename = `plan-${session}-${Date.now()}-plan.md`;
	return join(planDir, filename);
}

async function assertPlanPath(path: string): Promise<string> {
	if (!path || !resolve(path).endsWith("-plan.md") || resolve(path) !== path) {
		throw new Error("Invalid extension-owned plan file path");
	}
	const folder = dirname(path);
	if (await realpath(folder) !== folder) throw new Error("Refusing a redirected plan directory");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
			throw new Error("Plan path must be a regular, non-linked file");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return path;
}

export async function writePlan(path: string, content: string): Promise<void> {
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("The plan must be non-empty Markdown");
	}
	if (Buffer.byteLength(content, "utf8") > MAX_PLAN_BYTES) {
		throw new Error(`Plan exceeds the ${MAX_PLAN_BYTES / 1024} KiB limit`);
	}
	const target = await assertPlanPath(path);
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const nonBlock = constants.O_NONBLOCK ?? 0;
	const file = await open(target, constants.O_WRONLY | constants.O_CREAT | noFollow | nonBlock, 0o600);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink > 1) throw new Error("Plan target is not a private regular file");
		await file.truncate(0);
		await file.writeFile(content, { encoding: "utf8" });
	} finally {
		await file.close();
	}
}

export async function readPlan(path: string): Promise<string> {
	const target = await assertPlanPath(path);
	const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink > 1) throw new Error("Plan target is not a regular private file");
		if (info.size <= 0) throw new Error("Plan file is empty");
		if (info.size > MAX_PLAN_BYTES) throw new Error("Plan file exceeds the 200 KiB limit");
		return await file.readFile({ encoding: "utf8" });
	} finally {
		await file.close();
	}
}
