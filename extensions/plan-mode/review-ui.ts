import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ReviewChoice = "refine" | "execute-new" | "execute-here" | "cancel";

function fit(text: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(text, width, "");
}

function border(width: number, left: string, fill: string, right: string): string {
	if (width <= 1) return fit(fill, width);
	return left + fill.repeat(Math.max(0, width - 2)) + right;
}

function framedLine(text: string, width: number): string {
	if (width < 4) return fit(text, width);
	const contentWidth = width - 4;
	const content = truncateToWidth(text, contentWidth, "");
	const padding = Math.max(0, contentWidth - visibleWidth(content));
	return `│ ${content}${" ".repeat(padding)} │`;
}

function reviewLayout(rows: number): { topPadding: number; viewportHeight: number } {
	const topPadding = Math.min(3, Math.max(0, rows - 10));
	return { topPadding, viewportHeight: Math.max(1, rows - 8 - topPadding) };
}

export async function showPlanReview(
	ctx: ExtensionContext,
	path: string,
	content: string,
): Promise<ReviewChoice | undefined> {
	return ctx.ui.custom<ReviewChoice>((tui, theme, _keybindings, done) => {
		const markdown = new Markdown(content, 0, 0, getMarkdownTheme());
		let scrollTop = 0;

		const component = {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const innerWidth = Math.max(1, safeWidth - 4);
				const contentLines = markdown.render(innerWidth);
				const { topPadding, viewportHeight } = reviewLayout(tui.terminal.rows);
				const maxScroll = Math.max(0, contentLines.length - viewportHeight);
				scrollTop = Math.min(Math.max(0, scrollTop), maxScroll);

				const lines = [
					...Array.from({ length: topPadding }, () => ""),
					border(safeWidth, "╭", "─", "╮"),
					framedLine(theme.fg("accent", theme.bold("Plan review · approval required")), safeWidth),
					framedLine(theme.fg("dim", path), safeWidth),
				];
				for (let i = 0; i < viewportHeight; i++) {
					lines.push(framedLine(contentLines[scrollTop + i] ?? "", safeWidth));
				}
				const range = contentLines.length === 0
					? "0 lines"
					: `${scrollTop + 1}-${Math.min(scrollTop + viewportHeight, contentLines.length)} of ${contentLines.length}`;
				lines.push(framedLine(theme.fg("muted", `Scroll ${range} · ↑↓/PgUp/PgDn · Home/End`), safeWidth));
				lines.push(framedLine(theme.fg("accent", "[R] Refine  [N] Approve & Execute  [H] Approve & Continue Here  [Esc] Cancel"), safeWidth));
				lines.push(border(safeWidth, "╰", "─", "╯"));
				return lines.map((line) => fit(line, safeWidth));
			},
			handleInput(data: string): void {
				const { viewportHeight } = reviewLayout(tui.terminal.rows);
				const total = markdown.render(Math.max(1, tui.terminal.columns - 4)).length;
				const maxScroll = Math.max(0, total - viewportHeight);
				if (matchesKey(data, "escape")) return done("cancel");
				if (matchesKey(data, "r")) return done("refine");
				if (matchesKey(data, "n")) return done("execute-new");
				if (matchesKey(data, "h")) return done("execute-here");
				if (matchesKey(data, "up") || matchesKey(data, "k")) scrollTop = Math.max(0, scrollTop - 1);
				else if (matchesKey(data, "down") || matchesKey(data, "j")) scrollTop = Math.min(maxScroll, scrollTop + 1);
				else if (matchesKey(data, "pageUp")) scrollTop = Math.max(0, scrollTop - viewportHeight);
				else if (matchesKey(data, "pageDown")) scrollTop = Math.min(maxScroll, scrollTop + viewportHeight);
				else if (matchesKey(data, "home")) scrollTop = 0;
				else if (matchesKey(data, "end")) scrollTop = maxScroll;
				else return;
				tui.requestRender();
			},
			invalidate(): void {
				markdown.invalidate();
			},
		};

		return component;
	});
}
