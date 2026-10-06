// Frames on the broker socket: a 4-byte big-endian length, then that many
// bytes of UTF-8 JSON. Ported from pi-intercom 0.16.1 (MIT, Nico Bailon).
//
// The length is checked against the 1 MiB cap as soon as the header is in,
// before any payload is buffered, so a peer cannot make either side allocate
// an arbitrary amount of memory by declaring a huge frame.

import type { Socket } from "node:net";

export const MAX_FRAME_BYTES = 1024 * 1024;

export function writeMessage(socket: Pick<Socket, "write">, msg: unknown): void {
	const json = JSON.stringify(msg);
	const payloadLength = Buffer.byteLength(json, "utf-8");
	const frame = Buffer.allocUnsafe(4 + payloadLength);
	frame.writeUInt32BE(payloadLength, 0);
	frame.write(json, 4, payloadLength, "utf-8");
	socket.write(frame);
}

/**
 * Returns a data handler that reassembles frames across reads and calls
 * onMessage once per frame. A parse error, a handler exception or an oversized
 * frame goes to onError and stops processing the rest of that chunk, so the
 * caller can close the socket without acting on anything after the bad frame.
 */
export function createMessageReader(
	onMessage: (msg: unknown) => void,
	onError: (error: Error) => void,
	maxFrameBytes = MAX_FRAME_BYTES,
): (data: Buffer) => void {
	const header = Buffer.allocUnsafe(4);
	let headerBytes = 0;
	let payload: Buffer | null = null;
	let payloadBytes = 0;
	let payloadLength = 0;

	function reportMessage(framePayload: Buffer): boolean {
		let msg: unknown;
		try {
			msg = JSON.parse(framePayload.toString("utf-8"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
			return false;
		}
		try {
			onMessage(msg);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
			return false;
		}
	}

	return (data: Buffer) => {
		let offset = 0;

		while (offset < data.length) {
			if (headerBytes < 4) {
				const bytes = Math.min(4 - headerBytes, data.length - offset);
				data.copy(header, headerBytes, offset, offset + bytes);
				headerBytes += bytes;
				offset += bytes;
				if (headerBytes < 4) return;

				payloadLength = header.readUInt32BE(0);
				if (payloadLength > maxFrameBytes) {
					headerBytes = 0;
					onError(new Error(`Intercom frame length ${payloadLength} exceeds maximum ${maxFrameBytes} bytes`));
					return;
				}
			}

			// The whole payload is already in this chunk: parse it in place.
			if (payloadBytes === 0 && data.length - offset >= payloadLength) {
				const framePayload = data.subarray(offset, offset + payloadLength);
				offset += payloadLength;
				headerBytes = 0;
				payload = null;
				payloadLength = 0;
				if (!reportMessage(framePayload)) return;
				continue;
			}

			// Size-checked, not just presence-checked: a buffer left from a frame
			// whose chunk ended on a header boundary must not be reused for a frame
			// of another size.
			if (payload === null || payload.length !== payloadLength) {
				payload = Buffer.allocUnsafe(payloadLength);
			}
			const bytes = Math.min(payloadLength - payloadBytes, data.length - offset);
			data.copy(payload, payloadBytes, offset, offset + bytes);
			payloadBytes += bytes;
			offset += bytes;
			if (payloadBytes < payloadLength) return;

			const framePayload = payload;
			headerBytes = 0;
			payload = null;
			payloadBytes = 0;
			payloadLength = 0;
			if (!reportMessage(framePayload)) return;
		}
	};
}
