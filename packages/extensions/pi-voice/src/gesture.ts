/** Space starts only in an empty prompt; an active recording takes precedence. */
export class VoiceGesture {
	private pasting = false;

	feed(data: string, text: string, active: boolean): "start" | "stop" | "consume" | undefined {
		const start = data.lastIndexOf("\x1b[200~");
		const end = data.lastIndexOf("\x1b[201~");
		if (this.pasting || start >= 0 || end >= 0) {
			if (start >= 0 || end >= 0) this.pasting = start > end;
			return;
		}

		// Kitty reports presses, repeats and releases separately. Lock modifiers
		// do not change Space; Shift, Alt, Ctrl and Super are different shortcuts.
		const key = /^\x1b\[32(?::\d*){0,2}(?:;(\d+)(?::([123]))?)?u$/.exec(data);
		const space = data === " " || (key !== null && ((Number(key[1] ?? 1) - 1) & ~(64 + 128)) === 0);
		if (!space || key?.[2] === "3") return;
		if (key?.[2] === "2") return active ? "consume" : undefined;
		if (active) return "stop";
		if (text === "") return "start";
	}
}
