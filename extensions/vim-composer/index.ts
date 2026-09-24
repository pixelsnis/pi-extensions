import {
	CustomEditor,
	type AppKeybinding,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const APP_ACTIONS: AppKeybinding[] = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.thinking.save",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.session.toggleNamedFilter",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"app.message.dequeue",
	"app.clipboard.pasteImage",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
	"app.tree.editLabel",
	"app.tree.toggleLabelTimestamp",
	"app.session.togglePath",
	"app.session.toggleSort",
	"app.session.rename",
	"app.session.delete",
	"app.session.deleteNoninvasive",
	"app.models.save",
	"app.models.enableAll",
	"app.models.clearAll",
	"app.models.toggleProvider",
	"app.models.reorderUp",
	"app.models.reorderDown",
	"app.tree.filter.default",
	"app.tree.filter.noTools",
	"app.tree.filter.userOnly",
	"app.tree.filter.labeledOnly",
	"app.tree.filter.all",
	"app.tree.filter.cycleForward",
	"app.tree.filter.cycleBackward",
];

type Mode = "insert" | "normal" | "visual";
type Position = { line: number; col: number };
type YankRegister = { kind: "character" | "line"; text: string };

class VimComposerEditor extends CustomEditor {
	private mode: Mode = "insert";
	private anchor: Position | null = null;
	private pendingY = false;
	private register: YankRegister | null = null;
	private forwardingPaste = false;
	private readonly appKeybindings: KeybindingsManager;
	private readonly getCurrentTheme: () => Theme;
	private readonly isAgentIdle: () => boolean;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getCurrentTheme: () => Theme,
		isAgentIdle: () => boolean,
	) {
		super(tui, editorTheme, keybindings);
		this.appKeybindings = keybindings;
		this.getCurrentTheme = getCurrentTheme;
		this.isAgentIdle = isAgentIdle;
	}

	override setText(text: string): void {
		super.setText(text);
		this.anchor = null;
		this.pendingY = false;
		this.setMode("insert");
	}

	override handleInput(data: string): void {
		this.clampAnchor();

		if (this.isBracketedPasteInput(data)) {
			this.pendingY = false;
			this.forwardInput(data);
			return;
		}

		if (matchesKey(data, "escape")) {
			this.pendingY = false;
			if (!this.isAgentIdle()) {
				this.forwardInput(data);
			} else if (this.mode === "insert") {
				if (this.isShowingAutocomplete()) {
					this.forwardInput(data);
				} else {
					this.enterNormal();
				}
			} else if (this.mode === "visual") {
				this.enterNormal();
			}
			return;
		}

		if (this.mode === "insert") {
			if (this.isSubmitKey(data)) {
				if (!this.onExtensionShortcut?.(data)) this.insertTextAtCursor("\n");
			} else {
				this.forwardInput(data);
			}
			return;
		}

		const completesYy = this.pendingY && data === "y";
		this.pendingY = false;

		if (this.mode === "visual" && this.isSubmitKey(data)) {
			this.onExtensionShortcut?.(data);
			return;
		}
		if (this.isAppShortcut(data)) {
			this.forwardInput(data);
			return;
		}
		if (this.isPrintable(data) && this.onExtensionShortcut?.(data)) {
			return;
		}
		if (
			matchesKey(data, "backspace") ||
			matchesKey(data, "shift+backspace")
		) {
			this.onExtensionShortcut?.(data);
			return;
		}

		if (completesYy) {
			this.yankCurrentLine();
			return;
		}

		if (this.mode === "visual" && data === "y") {
			this.yankVisualSelection();
			this.enterNormal();
			return;
		}

		if (this.handleVimCommand(data)) return;

		if (!this.isPrintable(data)) {
			this.forwardInput(data);
		}
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		const border = super.renderBottomBorder(width, hiddenLineCount);
		const label = this.mode === "insert" ? "I" : this.mode === "visual" ? "V" : "N";
		const badge = ` ${label} `;
		const badgeWidth = visibleWidth(badge);

		// Keep at least one border stroke to the left of the badge.
		if (width < badgeWidth + 1 || visibleWidth(border) < badgeWidth + 1) {
			return border;
		}

		const theme = this.getCurrentTheme();
		const styledBadge =
			this.mode === "normal"
				? theme.fg("muted", badge)
				: this.mode === "visual"
					? theme.bold(theme.fg("text", badge))
					: theme.fg("text", badge);
		const prefix = truncateToWidth(border, width - badgeWidth, "");
		return prefix + styledBadge;
	}

	private handleVimCommand(data: string): boolean {
		if (data.length !== 1) return false;

		switch (data) {
			case "h":
				this.forwardInput("\x1b[D");
				return true;
			case "l":
				this.forwardInput("\x1b[C");
				return true;
			case "j":
				this.moveVertically(1);
				return true;
			case "k":
				this.moveVertically(-1);
				return true;
			case "w":
				this.forwardInput("\x1bf");
				return true;
			case "b":
				this.forwardInput("\x1bb");
				return true;
			case "0":
				this.forwardInput("\x01");
				return true;
			case "$":
				this.forwardInput("\x05");
				return true;
			case "i":
				this.enterInsert();
				return true;
			case "a":
				this.appendAtCursor();
				this.enterInsert();
				return true;
			case "v":
				if (this.mode === "visual") {
					this.enterNormal();
				} else {
					this.anchor = this.clampPosition(this.getCursor());
					this.setMode("visual");
				}
				return true;
			case "y":
				if (this.mode === "visual") {
					this.yankVisualSelection();
					this.enterNormal();
				} else {
					this.pendingY = true;
				}
				return true;
			case "p":
				if (this.mode === "normal") this.pasteRegister(true);
				return true;
			case "P":
				if (this.mode === "normal") this.pasteRegister(false);
				return true;
			default:
				return false;
		}
	}

	private moveVertically(direction: -1 | 1): void {
		const lines = this.getLines();
		const cursor = this.getCursor();
		if (direction < 0 && cursor.line === 0 && cursor.col === 0) return;

		if (direction > 0 && cursor.line >= lines.length - 1) {
			const line = lines[lines.length - 1] ?? "";
			if (cursor.col >= line.length) return;
		}

		this.forwardInput(direction < 0 ? "\x1b[A" : "\x1b[B");
	}

	private appendAtCursor(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (cursor.col < line.length) this.forwardInput("\x1b[C");
	}

	private pasteRegister(after: boolean): void {
		if (!this.register || (this.register.kind === "character" && this.register.text.length === 0)) return;

		if (this.register.kind === "line") {
			this.forwardInput(after ? "\x05" : "\x01");
			this.insertTextAtCursor(after ? `\n${this.register.text}` : `${this.register.text}\n`);
			return;
		}

		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (after && cursor.col < line.length) {
			this.forwardInput("\x1b[C");
		} else if (!after && cursor.col >= line.length && line.length > 0) {
			this.forwardInput("\x1b[D");
		}
		this.insertTextAtCursor(this.register.text);
	}

	private yankCurrentLine(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		this.register = { kind: "line", text: line };
	}

	private yankVisualSelection(): void {
		if (!this.anchor) return;

		const lines = this.getLines();
		const text = lines.join("\n");
		const anchorRange = this.inclusiveCharacterRange(this.anchor, lines);
		const cursorRange = this.inclusiveCharacterRange(this.getCursor(), lines);
		if (!anchorRange || !cursorRange) {
			this.register = { kind: "character", text: "" };
			return;
		}

		const start = Math.min(anchorRange.start, cursorRange.start);
		const end = Math.max(anchorRange.end, cursorRange.end);
		this.register = { kind: "character", text: text.slice(start, end) };
	}

	private inclusiveCharacterRange(position: Position, lines: string[]): { start: number; end: number } | null {
		const clamped = this.clampPosition(position, lines);
		const line = lines[clamped.line] ?? "";
		let lineStart = 0;
		for (let i = 0; i < clamped.line; i++) lineStart += (lines[i] ?? "").length + 1;

		const graphemes = Array.from(graphemeSegmenter.segment(line));
		if (graphemes.length === 0) {
			return clamped.line < lines.length - 1 ? { start: lineStart, end: lineStart + 1 } : null;
		}

		const grapheme =
			clamped.col >= line.length
				? graphemes[graphemes.length - 1]
				: graphemes.find(
						(item) => item.index <= clamped.col && clamped.col < item.index + item.segment.length,
					) ?? graphemes[0];
		if (!grapheme) return null;
		return {
			start: lineStart + grapheme.index,
			end: lineStart + grapheme.index + grapheme.segment.length,
		};
	}

	private enterInsert(): void {
		this.anchor = null;
		this.pendingY = false;
		this.setMode("insert");
	}

	private enterNormal(): void {
		this.anchor = null;
		this.pendingY = false;
		this.setMode("normal");
	}

	private setMode(mode: Mode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.tui.requestRender();
	}

	private forwardInput(data: string): void {
		const submitKey = this.appKeybindings.matches(data, "tui.input.submit") && !this.disableSubmit;
		const hadAutocomplete = this.isShowingAutocomplete();
		super.handleInput(data);
		if (submitKey && !this.isShowingAutocomplete() && (!hadAutocomplete || this.getText().length === 0)) {
			this.anchor = null;
			this.pendingY = false;
			this.setMode("insert");
		}
		this.clampAnchor();
	}

	private isAppShortcut(data: string): boolean {
		return APP_ACTIONS.some((action) => this.appKeybindings.matches(data, action));
	}

	private isSubmitKey(data: string): boolean {
		return this.appKeybindings.matches(data, "tui.input.submit");
	}

	private isBracketedPasteInput(data: string): boolean {
		if (this.forwardingPaste) {
			if (data.includes(PASTE_END)) this.forwardingPaste = false;
			return true;
		}

		const start = data.indexOf(PASTE_START);
		if (start < 0) return false;
		this.forwardingPaste = data.indexOf(PASTE_END, start + PASTE_START.length) < 0;
		return true;
	}

	private isPrintable(data: string): boolean {
		return data.length > 0 && !/[\x00-\x1f\x7f]/u.test(data);
	}

	private clampAnchor(): void {
		if (this.anchor) this.anchor = this.clampPosition(this.anchor);
	}

	private clampPosition(position: Position, lines = this.getLines()): Position {
		const safeLines = lines.length > 0 ? lines : [""];
		const line = Math.max(0, Math.min(Math.trunc(position.line), safeLines.length - 1));
		const text = safeLines[line] ?? "";
		const requestedCol = Math.max(0, Math.min(Math.trunc(position.col), text.length));
		if (requestedCol === text.length) return { line, col: requestedCol };

		for (const grapheme of graphemeSegmenter.segment(text)) {
			if (requestedCol === grapheme.index) return { line, col: requestedCol };
			if (requestedCol < grapheme.index + grapheme.segment.length) {
				return { line, col: grapheme.index };
			}
		}
		return { line, col: requestedCol };
	}
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new VimComposerEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, () => ctx.isIdle()),
		);
	});
}
